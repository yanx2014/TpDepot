#!/usr/bin/env python3
"""Batch-score LinkedIn search results against a configurable ICP.

Input JSON follows references/icp-schema.md and includes a top-level `profiles` list.
All score mathematics is deterministic. OpenAI supplies embeddings; Qwen is used only
for unresolved location containment and its answers are cached.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

EMBEDDING_MODEL = "text-embedding-3-small"
QWEN_MODEL = "qwen3.7-plus"
OUTPUT_FIELDS = [
    "Full Name",
    "Job Section",
    "Headline",
    "Location",
    "ICP Search Score",
    "LinkedIn Url",
]
STOPWORDS = {
    "a", "an", "and", "at", "de", "des", "du", "en", "et", "for", "la",
    "le", "les", "of", "or", "the", "to", "un", "une", "with",
}


def normalized_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    return re.sub(r"\s+", " ", text).strip()


def fold(value: Any) -> str:
    text = unicodedata.normalize("NFKD", normalized_text(value).casefold())
    return "".join(ch for ch in text if not unicodedata.combining(ch))


def tokens(value: Any) -> set[str]:
    return {t for t in re.findall(r"[\w+#.-]+", fold(value)) if t not in STOPWORDS}


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return 0.0 if not na or not nb else max(0.0, min(1.0, dot / (na * nb)))


def post_json(url: str, api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"API request failed ({exc.code}): {detail[:500]}") from exc


def embed(texts: list[str], cache: dict[str, Any]) -> dict[str, list[float]]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required; scores cannot be estimated")
    vectors = cache.setdefault("embeddings", {})
    missing: list[str] = []
    for text in dict.fromkeys(texts):
        key = hashlib.sha256(f"{EMBEDDING_MODEL}\0{text}".encode()).hexdigest()
        if key not in vectors:
            missing.append(text)
    if missing:
        response = post_json(
            "https://api.openai.com/v1/embeddings",
            api_key,
            {"model": EMBEDDING_MODEL, "input": missing, "encoding_format": "float"},
        )
        for text, item in zip(missing, response["data"]):
            key = hashlib.sha256(f"{EMBEDDING_MODEL}\0{text}".encode()).hexdigest()
            vectors[key] = item["embedding"]
    return {
        text: vectors[hashlib.sha256(f"{EMBEDDING_MODEL}\0{text}".encode()).hexdigest()]
        for text in dict.fromkeys(texts)
    }


def lexical_keyword_score(payload: str, criterion: dict[str, Any]) -> float | None:
    payload_folded = fold(payload)
    payload_tokens = tokens(payload)
    allow_tokens = bool(criterion.get("token_match_allowed", False))
    matches = 0
    for option in criterion.get("values", []):
        option_folded = fold(option)
        phrase_match = bool(option_folded and option_folded in payload_folded)
        token_match = allow_tokens and bool(tokens(option) & payload_tokens)
        if phrase_match or token_match:
            matches += 1
    minimum = max(1, int(criterion.get("minimum_matches", 1)))
    mode = criterion.get("match_mode", "any")
    required = len(criterion.get("values", [])) if mode == "all" else minimum
    return 1.0 if matches >= required else None


def exact_location_score(location: str, accepted: list[str]) -> float | None:
    loc = fold(location)
    if not loc:
        return 0.0
    if any(fold(item) == loc or fold(item) in loc for item in accepted):
        return 1.0
    return None


def resolve_locations_with_qwen(
    unresolved: list[str], accepted: list[str], cache: dict[str, Any]
) -> dict[str, float]:
    results: dict[str, float] = {}
    qcache = cache.setdefault("qwen_locations", {})
    pending: list[str] = []
    targets_key = hashlib.sha256(json.dumps(accepted, sort_keys=True).encode()).hexdigest()
    for location in dict.fromkeys(unresolved):
        key = f"v1:{targets_key}:{fold(location)}"
        if key in qcache:
            results[location] = float(qcache[key]["score"])
        else:
            pending.append(location)
    if not pending:
        return results
    api_key = os.environ.get("QWEN_API_KEY")
    base_url = os.environ.get("QWEN_BASE_URL", "").rstrip("/")
    if not api_key or not base_url:
        return results
    system = (
        "Resolve only geographic containment from displayed LinkedIn locations. "
        "Return JSON. Never invent missing geography. A location is accepted only when it is "
        "inside or equal to one of the accepted target locations."
    )
    user = {
        "accepted_locations": accepted,
        "displayed_locations": pending,
        "output_schema": {
            "results": [{
                "input": "string", "status": "exact|inferred|partial|no_match|unknown",
                "score": "1 for exact/inferred, 0.5 partial, 0 no_match/unknown",
                "confidence": "0..1",
            }]
        },
    }
    payload = {
        "model": os.environ.get("QWEN_MODEL", QWEN_MODEL),
        "temperature": 0,
        "max_tokens": min(1200, 100 + 70 * len(pending)),
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
        "enable_thinking": False,
    }
    response = post_json(f"{base_url}/chat/completions", api_key, payload)
    content = response["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    allowed_scores = {0.0, 0.5, 1.0}
    for item in parsed.get("results", []):
        source = normalized_text(item.get("input"))
        score = float(item.get("score", 0))
        confidence = float(item.get("confidence", 0))
        if source not in pending or score not in allowed_scores or not 0 <= confidence <= 1:
            continue
        if confidence < 0.75:
            score = 0.0
        key = f"v1:{targets_key}:{fold(source)}"
        qcache[key] = {"score": score, "confidence": confidence, "status": item.get("status")}
        results[source] = score
    return results


def canonical_linkedin_url(value: Any) -> str:
    url = normalized_text(value)
    url = re.sub(r"[?#].*$", "", url).rstrip("/")
    return url


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path, help="JSON containing icp and profiles")
    parser.add_argument("output", type=Path, help="semicolon-delimited CSV output")
    parser.add_argument("--cache", type=Path, default=Path(".icp-scoring-cache.json"))
    args = parser.parse_args()

    data = json.loads(args.input.read_text(encoding="utf-8"))
    criteria = data["icp"]["criteria"]
    profiles = data.get("profiles", [])
    if not profiles:
        raise ValueError("profiles must contain at least one result")

    active = {name: value for name, value in criteria.items() if value.get("values")}
    total_weight = sum(float(value.get("weight", 0)) for value in active.values())
    if total_weight <= 0:
        raise ValueError("active ICP criterion weights must total more than zero")
    weights = {name: float(value.get("weight", 0)) / total_weight for name, value in active.items()}

    cache = json.loads(args.cache.read_text()) if args.cache.exists() else {}
    semantic_texts: list[str] = []
    for criterion_name in ("job_titles", "keywords"):
        semantic_texts.extend(normalized_text(v) for v in active.get(criterion_name, {}).get("values", []))
    payloads: list[str] = []
    for profile in profiles:
        payload = normalized_text(f"{profile.get('job_section', '')} {profile.get('headline', '')}")
        payloads.append(payload or "[missing profile text]")
    semantic_texts.extend(payloads)
    vectors = embed(semantic_texts, cache)

    location_criterion = active.get("locations", {})
    accepted_locations = [normalized_text(v) for v in location_criterion.get("values", [])]
    unresolved_locations: list[str] = []
    exact_location_scores: dict[str, float] = {}
    for profile in profiles:
        location = normalized_text(profile.get("location"))
        value = exact_location_score(location, accepted_locations) if accepted_locations else 0.0
        if value is None:
            unresolved_locations.append(location)
        else:
            exact_location_scores[location] = value
    qwen_locations = resolve_locations_with_qwen(unresolved_locations, accepted_locations, cache)

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for profile, payload in zip(profiles, payloads):
        url = canonical_linkedin_url(profile.get("linkedin_url"))
        dedupe_key = url or hashlib.sha256(
            f"{fold(profile.get('full_name'))}\0{fold(payload)}".encode()
        ).hexdigest()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        total = 0.0

        if "job_titles" in active:
            options = [normalized_text(v) for v in active["job_titles"]["values"]]
            similarity = max(cosine(vectors[payload], vectors[option]) for option in options)
            total += similarity * weights["job_titles"]

        if "keywords" in active:
            criterion = active["keywords"]
            lexical = lexical_keyword_score(payload, criterion)
            if lexical is None:
                options = [normalized_text(v) for v in criterion["values"]]
                lexical = max(cosine(vectors[payload], vectors[option]) for option in options)
            total += lexical * weights["keywords"]

        if "locations" in active:
            location = normalized_text(profile.get("location"))
            score = exact_location_scores.get(location, qwen_locations.get(location, 0.0))
            total += score * weights["locations"]

        rows.append({
            "Full Name": normalized_text(profile.get("full_name")),
            "Job Section": normalized_text(profile.get("job_section")),
            "Headline": normalized_text(profile.get("headline")),
            "Location": normalized_text(profile.get("location")),
            "ICP Search Score": max(0, min(100, round(total * 100))),
            "LinkedIn Url": url,
        })

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=OUTPUT_FIELDS, delimiter=";", quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        writer.writerows(rows)
    args.cache.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"icp-scoring: {exc}", file=sys.stderr)
        raise SystemExit(2)
