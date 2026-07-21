---
name: icp-scoring
description: Score, qualify, rank, filter, or triage LinkedIn search results, profile lists, screenshots, CSV files, or structured lead records against any user-defined ICP. Use OpenAI text-embedding-3-small for semantic comparison, deterministic rules for scoring, and minimal cached qwen3.7-plus calls only to resolve ambiguous or missing normalization facts. Export a semicolon-delimited CSV with Full Name, Job Section, Headline, Location, ICP Search Score, and LinkedIn Url.
---

# Generalized ICP Scoring

Compare every LinkedIn result independently with an arbitrary ICP. Treat all built-in examples as examples, never fixed market logic.

## Required output

Always create a UTF-8 CSV using `;` as the delimiter and this exact header order:

```text
Full Name;Job Section;Headline;Location;ICP Search Score;LinkedIn Url
```

Preserve source text in the five descriptive columns. Format `ICP Search Score` as an integer from 0 through 100. Do not add columns unless the user explicitly requests them.

## Required models

- Use OpenAI `text-embedding-3-small` exclusively for embeddings.
- Use `qwen3.7-plus` only when deterministic rules, cache lookup, and embeddings cannot reliably resolve information needed for scoring.
- Never substitute another embedding or language model.
- If embeddings cannot be computed, set the score to `NOT COMPUTED`; never estimate a similarity with an LLM.

## Inputs

Accept:

- An ICP written as prose, Markdown, JSON, or YAML.
- LinkedIn search-result screenshots, visible DOM data, CSV rows, or structured records.
- Optional weights, required criteria, keyword policies, thresholds, and location rules.

Compile the ICP into the schema in [references/icp-schema.md](references/icp-schema.md). Preserve the user's criteria and meaning. Do not silently add market assumptions.

Extract these output fields for each result:

- `Full Name`
- `Job Section`: current job text visible in the search result. Exclude previous jobs unless the user explicitly includes them.
- `Headline`: visible LinkedIn headline.
- `Location`: displayed source text.
- `LinkedIn Url`: canonical profile URL when supplied or captured; otherwise leave blank.

Ignore connection names, follower counts, relationship degree, UI labels, and unrelated page text.

## Workflow

### 1. Validate and compile the ICP

1. Extract every explicit criterion, accepted value, requirement, weight, and matching policy.
2. Classify criteria as semantic text, location, keyword, numeric range, enumeration, or boolean.
3. Use supplied weights. If omitted for the standard search-result fields, default to job titles 60, locations 25, and keywords 15.
4. Normalize weights to total 100 in code.
5. Do not invent criteria the user did not provide.

For unstructured ICP prose only, permit one Qwen call to compile it into the schema. Require JSON output and validate it before use.

### 2. Extract and normalize LinkedIn results

Prefer structured DOM or CSV fields. For screenshots, transcribe only visible evidence and mark unreadable fields blank. Do not infer a LinkedIn URL from a person's name.

Build semantic payloads:

```text
job_payload = Job Section + Headline
keyword_payload = Job Section + Headline
```

Preserve original source strings separately from normalized values.

### 3. Resolve deterministic evidence first

Before any model call:

- Normalize Unicode, whitespace, case, punctuation, accents, URLs, and number ranges.
- Apply exact phrase, whole-token, acronym, and explicit synonym matching.
- Reject stopwords as keyword evidence.
- Resolve locations already equal to an accepted ICP location.
- Read existing normalization and Qwen cache entries.

Never match short tokens as substrings. For example, match `IA` as a whole token, not inside another word.

### 4. Compute embeddings efficiently

1. Hash the normalized ICP and reuse cached ICP vectors.
2. Embed accepted semantic criterion values and all profile payloads in as few batch requests as possible.
3. Compare a profile with every accepted value for the criterion and retain the maximum cosine similarity.
4. Clamp cosine similarity to the interval 0 through 1 before weighting.
5. Cache embeddings by model and normalized-text hash.

For job titles:

```text
job_similarity = max(cosine(profile_job_vector, accepted_title_vector_i))
```

For keywords, apply an exact configured lexical match first. If none exists, use maximum embedding similarity against keyword options. Honor `match_mode`, `token_match_allowed`, and `minimum_matches` from the ICP.

### 5. Use Qwen only for unresolved facts

Call Qwen only when the unresolved fact materially affects the score:

- Map an unfamiliar displayed city or region to the ICP's accepted geography.
- Normalize an ambiguous job/title fragment.
- Resolve an acronym or domain-specific synonym not handled by lexical matching.
- Separate malformed fields.
- Resolve contradictory visible evidence.
- Compile an unstructured ICP.

Do not call Qwen for clear exact matches, clear nonmatches, cached facts, or profiles whose verdict cannot change.

Batch unresolved items from multiple profiles into one request. Send only the minimal relevant strings and ICP criterion. Use structured JSON, temperature 0, disabled thinking when supported, and a small output-token limit. Cache results using normalized input, criterion type, model, and prompt version.

Qwen may return normalized evidence, status, and confidence. It must not return or calculate the final score. Reject malformed output and return `UNKNOWN` rather than guessing.

Do not use Qwen memory as authoritative evidence for changing facts such as current headcount, revenue, employer, or industry. Use supplied or authorized current evidence, otherwise leave the fact unknown.

### 6. Calculate scores only in code

For every criterion:

```text
criterion_points = criterion_similarity_or_match × normalized_weight
total_score = round(sum(criterion_points))
```

Use deterministic comparison for exact ranges and booleans. Use hierarchical location status:

- `EXACT` or confidently `INFERRED` inside an accepted location: 1.0
- `PARTIAL` regional overlap: configured partial value, default 0.5
- `NO_MATCH` or `UNKNOWN`: 0.0

Missing required evidence receives zero points and lowers internal evidence coverage. Do not renormalize away a missing required criterion. Keep evidence coverage and decision traces internally even though the default CSV contains only the final score.

Apply any explicit user-supplied gate or cap after weighted scoring. Do not add a geographic or industry gate unless the ICP marks it required or the user requests one.

### 7. Export and verify

Use [scripts/score_icp.py](scripts/score_icp.py) when structured input is available. Verify:

- Exact six-column header and order.
- Semicolon delimiter.
- One row per distinct LinkedIn result.
- Canonical LinkedIn URL deduplication when URLs exist.
- No fabricated fields.
- Integer score 0-100 or `NOT COMPUTED`.
- Correct CSV quoting for semicolons, quotes, and line breaks.

Return the CSV file and a concise count of scored, uncomputed, and deduplicated rows.

## Security

Read secrets from backend environment variables only:

```text
OPENAI_API_KEY
QWEN_API_KEY
QWEN_BASE_URL
QWEN_MODEL=qwen3.7-plus
```

Never expose or embed keys in extension source, frontend bundles, logs, prompts, CSV output, or version control. Route extension requests through a backend. Make the Qwen base URL configurable because providers and regions differ.

## Legacy framework

Read [references/original-recruitment-framework.md](references/original-recruitment-framework.md) only when scoring the original French recruitment-cabinet ICPs or when reproducing its detailed report. The generalized CSV workflow and current user-supplied ICP take precedence.
