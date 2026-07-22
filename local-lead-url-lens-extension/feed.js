/* Local Lead URL Lens — local ICP scoring engine (no backend).
 *
 * Reproduces the documented scoring contract EXACTLY and deterministically in code:
 *
 *     ICP Search Score = 65 · jobTitleMatch + 20 · jobSectionHeadlineMatch + 15 · locationMatch
 *
 * where each match term is in [0,1]. The weights are FIXED (they are the contract,
 * not taken from the ICP). The LLM never assigns points — it is used only to (a)
 * compile a prose ICP into accepted values and (b) normalize an unresolved location.
 * Semantic matches use OpenAI text-embedding-3-small (the contract mandates
 * embeddings; never substituted). If a required embedding is unavailable the row
 * scores NOT COMPUTED — never an invented value.
 */

// FIXED scoring contract weights (Job Title 65 · Job Section/Headline 20 · Location 15).
export const WEIGHTS = { job_title: 0.65, job_section_headline: 0.20, location: 0.15 };
export const EMBED_MODEL = "text-embedding-3-small";
// Cosine calibration for embedding matches: raw cosines from text-embedding-3-small
// cluster (~0.25-0.40 unrelated, ~0.80+ near-synonym), so raw values compress the
// 0-100 range. Cosine ≤ floor scores 0, ≥ ceil scores 1, linear in between.
export const CALIBRATION = { floor: 0.35, ceil: 0.80 };
export const SCORE_CSV_HEADERS = [
  "Full Name", "Job Title", "Job Section", "Headline", "Location",
  "ICP Search Score", "Job Title (65)", "Job Section/Headline (20)", "Location (15)",
  "Qwen Review", "Note", "LinkedIn Url",
];

/* ------------------------------------------------------------------ parsing */
export function canonicalProfileUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    const standard = url.pathname.match(/^\/in\/([^/?#]+)/i);
    const sales = url.pathname.match(/^\/sales\/lead\/([^/?#]+)/i);
    if (standard) return `https://www.linkedin.com/in/${decodeURIComponent(standard[1]).toLowerCase()}`;
    if (sales) return `https://www.linkedin.com/sales/lead/${sales[1]}`;
    return "";
  } catch { return ""; }
}
export function canonicalUrl(value) {
  const url = normText(value);
  return url.replace(/[?#].*$/, "").replace(/\/+$/, "");
}

/* ---------------------------------------------- text normalization (parity) */
export function normText(value) {
  return String(value == null ? "" : value).normalize("NFKC").replace(/\s+/g, " ").trim();
}
export function fold(value) {
  return normText(value).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0, n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? Math.max(0, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb)))) : 0;
}

/* --------------------------------------------- captured row → scoring fields */
// The current-position "Job Title": prefer the explicit Job Section (Poste actuel /
// Current position) text, else the first segment of the headline before "at/chez/@".
export function headlineParts(headline) {
  const first = String(headline || "").split(/[|•·]/)[0].trim();
  const m = first.match(/^(.*?)\s+(?:at|chez|@|-)\s+(.+)$/i);
  return m ? { title: m[1].trim(), company: m[2].trim() } : { title: first, company: "" };
}
// Strip a leading "Poste actuel :" / "Current position :" marker from the Job Section.
export function jobTitleFromSection(jobSection, headline) {
  const section = normText(jobSection).replace(/^(?:poste actuel|current position|current role)\s*:\s*/i, "");
  if (section) {
    const hp = headlineParts(section);
    return hp.title || section;
  }
  return headlineParts(headline).title;
}
// Build the descriptive fields used for scoring + CSV from one captured search row.
export function rowFieldsFromCapture(data = {}) {
  const job_section = normText(data.job_section);
  const headline = normText(data.headline);
  const job_title = normText(jobTitleFromSection(job_section, headline));
  return {
    full_name: normText(data.full_name),
    job_title,
    job_section,
    headline,
    location: normText(data.location),
    linkedin_url: canonicalProfileUrl(data.profile_url) || canonicalUrl(data.profile_url),
  };
}

/* ----------------------------------------------------- ICP schema + compile */
// Keep only the accepted-value lists this engine scores against.
export function activeIcp(icp) {
  const c = (icp && (icp.criteria || icp)) || {};
  const list = key => {
    const v = c[key];
    const values = Array.isArray(v) ? v : (v && Array.isArray(v.values) ? v.values : []);
    return values.map(normText).filter(Boolean);
  };
  return {
    job_titles: list("job_titles"), keywords: list("keywords"), locations: list("locations"),
    // Optional Qwen-generated variants (synonyms / abbreviations / FR-EN translations);
    // scoring takes the max over originals ∪ variants — the accepted values stay authoritative.
    job_title_variants: list("job_title_variants"), keyword_variants: list("keyword_variants"),
  };
}
// Qwen prompt: compile a prose/markdown ICP into the accepted-value lists (one cached call).
// Weights are NOT requested — they are fixed by the contract.
export function compileIcpPrompt(icpText) {
  const system = `You compile a user's Ideal Customer Profile (ICP) into a strict JSON schema for LinkedIn lead scoring. Extract ONLY criteria the user actually provided; never invent market assumptions. Keep values verbatim from the ICP text. Output ONLY a JSON object (no prose, no markdown fences) of the exact shape:
{"criteria":{
  "job_titles":["<accepted job title>", "..."],
  "keywords":["<accepted keyword/phrase>", "..."],
  "locations":["<accepted place>", "..."]
}}
Rules: include a list ONLY if the ICP supplies values for it (use an empty array otherwise). If the ICP contains multiple sub-ICPs, merge their titles/keywords/locations into the single lists. Do NOT output weights.`;
  return { system, user: `ICP:\n${icpText}`, max_tokens: 1500, temperature: 0, json: true };
}
// Qwen prompt: expand accepted titles/keywords into strict variants (synonyms,
// abbreviations, FR-EN translations). One cached call; expansion is best-effort and
// only widens matching — the accepted values and the scoring rule are unchanged.
export function expandIcpPrompt(icp) {
  const system = `You expand accepted ICP values for LinkedIn lead scoring. For each accepted job title and keyword, generate close variants a matching profile might display instead: common synonyms, standard abbreviations (e.g. "VP" / "Vice President"), and French/English translations. Stay strictly equivalent in seniority and function — never broaden to a different role or a more junior/senior level. Output ONLY a JSON object: {"job_title_variants":["…"],"keyword_variants":["…"]} containing ONLY the new variants (not the originals).`;
  const user = JSON.stringify({ job_titles: icp.job_titles, keywords: icp.keywords });
  return { system, user, max_tokens: 1200, temperature: 0, json: true };
}
// Qwen prompt: advisory review of one borderline prospect. The verdict goes in its own
// CSV column and NEVER changes the numeric score (the LLM never assigns points).
export function reviewPrompt(rf, icp) {
  const system = `You audit one LinkedIn prospect against an ICP. Judge ONLY from the provided facts; never invent data. Output ONLY a JSON object: {"verdict":"fit|no_fit|uncertain","reason":"<max 12 words citing the decisive fact>"}. This is an advisory review; it does not change any score.`;
  const user = JSON.stringify({
    icp: { job_titles: icp.job_titles, keywords: icp.keywords, locations: icp.locations },
    prospect: { job_title: rf.job_title, job_section: rf.job_section, headline: rf.headline, location: rf.location },
  });
  return { system, user, max_tokens: 120, temperature: 0, json: true };
}
// Qwen prompt: resolve an unresolved displayed location against accepted geography.
export function locationNormalizePrompt(displayed, accepted) {
  const system = "Resolve only geographic containment from displayed LinkedIn locations. Return JSON. Never invent missing geography. A location is accepted only when it is inside or equal to one of the accepted target locations.";
  const user = JSON.stringify({
    accepted_locations: accepted,
    displayed_locations: displayed,
    output_schema: { results: [{ input: "string", status: "exact|inferred|partial|no_match|unknown", score: "1 for exact/inferred, 0.5 partial, 0 no_match/unknown", confidence: "0..1" }] },
  });
  return { system, user, max_tokens: Math.min(1200, 100 + 70 * displayed.length), temperature: 0, json: true };
}

/* ------------------------------------------------------- deterministic scoring */
// Exact/containment location score: 1.0 if an accepted term equals or is contained in
// the displayed location, 0.0 if the location is blank, null if unresolved (Qwen needed).
export function exactLocationScore(location, accepted) {
  const loc = fold(location);
  if (!loc) return 0.0;
  for (const item of accepted) { const f = fold(item); if (f && (f === loc || loc.includes(f))) return 1.0; }
  return null;
}
// Calibrated embedding match: cosine ≤ floor → 0, ≥ ceil → 1, linear in between.
export function calibrate(cos) {
  if (cos === null || cos === undefined) return null;
  return Math.max(0, Math.min(1, (cos - CALIBRATION.floor) / (CALIBRATION.ceil - CALIBRATION.floor)));
}
// Lexical exact/whole-phrase match: true when an accepted value appears in the text as a
// whole word/phrase (accent- and case-insensitive). A lexical hit scores the term 1.0
// without needing embeddings.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function lexicalMatch(text, values) {
  const t = fold(text);
  if (!t) return false;
  for (const v of values) {
    const f = fold(v);
    if (!f || f.length < 2) continue;
    if (new RegExp(`(?:^|[^a-z0-9])${escapeRe(f)}(?:[^a-z0-9]|$)`).test(t)) return true;
  }
  return false;
}
// Best cosine of `text` against a list of accepted values, using the shared vector map.
function bestMatch(text, values, vectors) {
  const tv = vectors[normText(text)];
  if (!tv) return null; // embedding unavailable → caller decides NOT COMPUTED
  let best = 0;
  for (const v of values) { const ov = vectors[normText(v)]; if (ov) best = Math.max(best, cosine(tv, ov)); }
  return best;
}
// One weighted term: lexical exact match first (1.0, rescues missing embeddings), else
// calibrated best-cosine via embeddings (null → NOT COMPUTED decided by the caller).
function matchTerm(text, values, vectors) {
  if (!values.length) return 0;
  if (lexicalMatch(text, values)) return 1.0;
  return calibrate(bestMatch(text, values, vectors));
}
// Score one captured row against the ICP. `vectors` maps normalized text → embedding.
// Returns {score, job_title, job_section_headline, location} where score is an integer
// 0–100 or "NOT COMPUTED" when a required semantic embedding could not be produced.
export function scoreRow(rf, icp, vectors, locationScore) {
  const jobTitleText = rf.job_title || "";
  const sectionHeadlineText = normText(`${rf.job_section} ${rf.headline}`);
  const titleValues = [...new Set([...icp.job_titles, ...(icp.job_title_variants || [])])];
  const semanticValues = [...new Set([...titleValues, ...icp.keywords, ...(icp.keyword_variants || [])])];

  // Job Title (65): profile title vs accepted job titles (∪ variants).
  const jt = icp.job_titles.length ? matchTerm(jobTitleText || sectionHeadlineText, titleValues, vectors) : 0;
  // Job Section/Headline (20): section+headline text vs accepted titles ∪ keywords (∪ variants).
  const jsh = semanticValues.length ? matchTerm(sectionHeadlineText || jobTitleText, semanticValues, vectors) : 0;
  if (jt === null || jsh === null) {
    return { score: "NOT COMPUTED", job_title: null, job_section_headline: null, location: locationScore };
  }
  const loc = icp.locations.length ? (Number.isFinite(locationScore) ? locationScore : 0) : 0;
  const total = WEIGHTS.job_title * (jt || 0) + WEIGHTS.job_section_headline * (jsh || 0) + WEIGHTS.location * loc;
  return {
    score: Math.max(0, Math.min(100, Math.round(total * 100))),
    job_title: jt || 0,
    job_section_headline: jsh || 0,
    location: loc,
  };
}
// Every embeddable ICP text (accepted job titles ∪ keywords, incl. variants).
export function icpEmbedTexts(icp) {
  return [...new Set([
    ...icp.job_titles, ...icp.keywords,
    ...(icp.job_title_variants || []), ...(icp.keyword_variants || []),
  ].map(normText).filter(Boolean))];
}

/* --------------------------------------------------------------- CSV (semicolon) */
function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function pct(value) { return value === null || value === undefined ? "" : `${Math.round(Number(value) * 100)}%`; }
export function buildScoreCsv(rows) {
  const lines = [SCORE_CSV_HEADERS.join(";")];
  for (const r of rows) {
    lines.push([
      r.full_name, r.job_title, r.job_section, r.headline, r.location,
      r.icp_score, pct(r.c_job_title), pct(r.c_job_section_headline), pct(r.c_location),
      r.qwen_review || "", r.note || "", r.linkedin_url,
    ].map(csvCell).join(";"));
  }
  return "﻿" + lines.join("\r\n"); // UTF-8 BOM (utf-8-sig parity)
}
export function csvDataUrl(csv) { return "data:text/csv;charset=utf-8," + encodeURIComponent(csv); }

/* --------------------------------------------------------------- LLM + embeddings */
const DASHSCOPE = { intl: "https://dashscope-intl.aliyuncs.com", cn: "https://dashscope.aliyuncs.com" };
const qwenBase = region => DASHSCOPE[region] || DASHSCOPE.intl;
async function timedFetch(url, options, ms = 120000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (e) { if (e?.name === "AbortError") throw new Error("Request timed out."); throw e; }
  finally { clearTimeout(timer); }
}
// Qwen chat (DashScope OpenAI-compatible). Used only for ICP compile + location normalization.
export async function chatLLM({ apiKey, model, region = "intl", system, user, max_tokens = 1024, temperature, json }) {
  if (!apiKey) throw new Error("Qwen API key is required.");
  const url = `${qwenBase(region)}/compatible-mode/v1/chat/completions`;
  const body = { model: model || "qwen3.7-plus", max_tokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
  if (typeof temperature === "number") body.temperature = temperature;
  if (json) { body.response_format = { type: "json_object" }; body.enable_thinking = false; }
  const r = await timedFetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
  const p = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(p?.error?.message || p?.message || `Qwen error ${r.status}`);
  return (p?.choices?.[0]?.message?.content || "").trim();
}
// Embeddings — OpenAI text-embedding-3-small exclusively (contract: never substitute).
export async function embed(texts, { apiKey } = {}) {
  if (!apiKey) throw new Error("OpenAI API key is required for embeddings.");
  if (!texts.length) return [];
  const r = await timedFetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, encoding_format: "float" }),
  }, 60000);
  const p = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(p?.error?.message || p?.message || `embeddings error ${r.status}`);
  return (p?.data || []).map(d => d.embedding);
}
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try { return JSON.parse(candidate.trim()); } catch {}
  const start = candidate.indexOf("{"), end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) { try { return JSON.parse(candidate.slice(start, end + 1)); } catch {} }
  return null;
}

/* ------------------------------------------------ passphrase-gated key vault (PBKDF2 + AES-GCM) */
export const KDF_ITERATIONS = 210000;
const VERIFIER_TEXT = "local-lead-url-lens-vault-verifier";
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveAesKey(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: KDF_ITERATIONS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}
export async function deriveVaultKey(passphrase, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  return { key: await deriveAesKey(passphrase, salt), saltB64: b64(salt) };
}
export async function exportKeyRaw(key) { return b64(new Uint8Array(await crypto.subtle.exportKey("raw", key))); }
export async function importKeyRaw(raw) { return crypto.subtle.importKey("raw", unb64(raw), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]); }
export async function encryptWithKey(key, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(String(plain))));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function decryptWithKey(key, obj) {
  if (!obj || !obj.iv || !obj.ct) return "";
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(obj.iv) }, key, unb64(obj.ct)));
}
export async function makeVerifier(key) { return encryptWithKey(key, VERIFIER_TEXT); }
export async function checkVerifier(key, verifier) {
  try { return (await decryptWithKey(key, verifier)) === VERIFIER_TEXT; } catch { return false; }
}
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
