/* TechNFirms Lead URL Lens — Feed pipeline (generalized ICP scoring skill).
 *
 * Implements the `icp-scoring` skill: score each LinkedIn result 0-100 against a
 * user-defined ICP compiled into the schema (job_titles / locations / keywords +
 * weights). All score math is deterministic and computed in code — the LLM never
 * computes the score. OpenAI text-embedding-3-small is used exclusively for
 * embeddings; Qwen is used only to (a) compile prose ICPs into the schema and
 * (b) normalize unresolved locations. If embeddings can't run, the score is
 * NOT COMPUTED. Output is a semicolon-delimited CSV.
 *
 * Mirrors scripts/score_icp.py from the skill for parity.
 */

export const SCORE_CSV_HEADERS = ["Full Name", "Job Section", "Headline", "Location", "ICP Search Score", "LinkedIn Url"];
export const EMBED_MODEL = "text-embedding-3-small";

/* ------------------------------------------------------------------ parsing */
export function parseProfileLinks(text) {
  const urls = [], seen = new Set();
  const pattern = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in\/[^\s)"'<>]+|sales\/lead\/[^\s)"'<>]+)/gi;
  for (const raw of String(text || "").match(pattern) || []) {
    const canonical = canonicalProfileUrl(raw);
    if (canonical && !seen.has(canonical)) { seen.add(canonical); urls.push(canonical); }
  }
  return urls;
}
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
// Canonicalize any supplied URL for CSV output / dedupe (strip query + hash + trailing slash).
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
const STOPWORDS = new Set(["a", "an", "and", "at", "de", "des", "du", "en", "et", "for", "la", "le", "les", "of", "or", "the", "to", "un", "une", "with"]);
export function tokenize(value) {
  const out = new Set();
  for (const t of fold(value).match(/[\w+#.-]+/g) || []) if (!STOPWORDS.has(t)) out.add(t);
  return out;
}
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0, n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? Math.max(0, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb)))) : 0;
}

/* --------------------------------------------- profile → output row fields */
// Fallback current title + company parsed from the headline (e.g. "Director at Morgan Stanley | …").
export function headlineParts(headline) {
  const first = String(headline || "").split(/[|•·]/)[0].trim();
  const m = first.match(/^(.*?)\s+(?:at|chez|@|-)\s+(.+)$/i);
  return m ? { title: m[1].trim(), company: m[2].trim() } : { title: first, company: "" };
}
// Build the five descriptive output fields from a captured profile.
// Job Section = current job text only (current role + company); previous jobs excluded.
export function rowFieldsFromCapture(data = {}) {
  const hp = headlineParts(data.headline);
  const role = data.role_headline || data.role || hp.title || "";
  const company = data.company || hp.company || "";
  const jobSection = [role, company].filter(Boolean).join(" · ") || normText(data.headline);
  return {
    full_name: normText(data.full_name),
    job_section: normText(jobSection),
    headline: normText(data.headline),
    location: normText(data.location),
    linkedin_url: canonicalProfileUrl(data.profile_url) || canonicalUrl(data.profile_url),
  };
}

/* ----------------------------------------------------- ICP schema + compile */
// Keep only criteria that actually carry values, and normalize weights to sum 1.
export function activeCriteria(icp) {
  const criteria = (icp && icp.criteria) || {};
  const active = {};
  for (const [name, c] of Object.entries(criteria)) if (c && Array.isArray(c.values) && c.values.length) active[name] = c;
  return active;
}
export function normalizedWeights(active) {
  let total = 0;
  for (const c of Object.values(active)) total += Number(c.weight) || 0;
  if (total <= 0) return null;
  const w = {};
  for (const [n, c] of Object.entries(active)) w[n] = (Number(c.weight) || 0) / total;
  return w;
}
// Qwen prompt to compile a prose/markdown/JSON ICP into the schema (one cached call).
export function compileIcpPrompt(icpText) {
  const system = `You compile a user's Ideal Customer Profile (ICP) into a strict JSON schema for LinkedIn lead scoring. Extract ONLY criteria the user actually provided; never invent market assumptions. Keep values verbatim from the ICP text. Output ONLY a JSON object (no prose, no markdown fences) of the exact shape:
{"icp":{"name":"<short name>","criteria":{
  "job_titles":{"type":"semantic","values":["<title>", "..."],"weight":60,"required":true},
  "locations":{"type":"location","values":["<place>", "..."],"weight":25,"required":true,"partial_score":0.5},
  "keywords":{"type":"keyword","values":["<keyword/phrase>", "..."],"weight":15,"required":false,"match_mode":"any","token_match_allowed":true,"minimum_matches":1}
}}}
Rules: include a criterion ONLY if the ICP supplies values for it (omit empty ones). Use the user's weights if stated; otherwise default job_titles 60, locations 25, keywords 15. If the ICP contains multiple sub-ICPs, merge their titles/keywords into the single lists.`;
  return { system, user: `ICP:\n${icpText}`, max_tokens: 1500, temperature: 0, json: true };
}
// Qwen prompt to resolve unresolved displayed locations against accepted geography.
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
// Keyword lexical score: 1.0 if enough phrase/token matches, else null (fall back to embeddings).
export function lexicalKeywordScore(payload, criterion) {
  const payloadFold = fold(payload), payloadTokens = tokenize(payload);
  const allowTokens = Boolean(criterion.token_match_allowed);
  let matches = 0;
  for (const option of criterion.values || []) {
    const optFold = fold(option);
    const phrase = Boolean(optFold && payloadFold.includes(optFold));
    const token = allowTokens && [...tokenize(option)].some(t => payloadTokens.has(t));
    if (phrase || token) matches += 1;
  }
  const minimum = Math.max(1, parseInt(criterion.minimum_matches || 1, 10) || 1);
  const required = criterion.match_mode === "all" ? (criterion.values || []).length : minimum;
  return matches >= required ? 1.0 : null;
}
// Exact/containment location score: 1.0 if accepted term equals or is contained in the location,
// 0.0 if location is blank, null if unresolved (needs Qwen normalization).
export function exactLocationScore(location, accepted) {
  const loc = fold(location);
  if (!loc) return 0.0;
  for (const item of accepted) { const f = fold(item); if (f && (f === loc || loc.includes(f))) return 1.0; }
  return null;
}
// Score one profile row. vectors maps normalized text -> embedding. Returns an
// integer 0-100, or "NOT COMPUTED" when a required embedding is unavailable.
export function scoreProfile(row, active, weights, vectors, locationScore) {
  const payload = normText(`${row.job_section} ${row.headline}`) || "[missing profile text]";
  let total = 0;
  if (active.job_titles) {
    const pv = vectors[payload]; if (!pv) return "NOT COMPUTED";
    let best = 0;
    for (const v of active.job_titles.values) { const ov = vectors[normText(v)]; if (ov) best = Math.max(best, cosine(pv, ov)); }
    total += best * weights.job_titles;
  }
  if (active.keywords) {
    let s = lexicalKeywordScore(payload, active.keywords);
    if (s === null) {
      const pv = vectors[payload]; if (!pv) return "NOT COMPUTED";
      let best = 0;
      for (const v of active.keywords.values) { const ov = vectors[normText(v)]; if (ov) best = Math.max(best, cosine(pv, ov)); }
      s = best;
    }
    total += s * weights.keywords;
  }
  if (active.locations) total += (Number.isFinite(locationScore) ? locationScore : 0) * weights.locations;
  return Math.max(0, Math.min(100, Math.round(total * 100)));
}
// Every embeddable text for the ICP (accepted values across semantic + keyword criteria).
export function icpEmbedTexts(active) {
  const out = [];
  for (const name of ["job_titles", "keywords"]) {
    if (active[name]) for (const v of active[name].values) out.push(normText(v));
  }
  return [...new Set(out.filter(Boolean))];
}

/* --------------------------------------------------------------- CSV (semicolon) */
function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function buildScoreCsv(rows) {
  const lines = [SCORE_CSV_HEADERS.join(";")];
  for (const r of rows) {
    lines.push([r.full_name, r.job_section, r.headline, r.location, r.icp_score, r.linkedin_url].map(csvCell).join(";"));
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
export async function chatLLM({ provider = "qwen", apiKey, model, region = "intl", system, user, max_tokens = 1024, temperature, json }) {
  if (!apiKey) throw new Error("Qwen API key is required.");
  const url = provider === "openai" ? "https://api.openai.com/v1/chat/completions" : `${qwenBase(region)}/compatible-mode/v1/chat/completions`;
  const body = { model: model || (provider === "openai" ? "gpt-4o-mini" : "qwen3.7-plus"), max_tokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
  if (typeof temperature === "number") body.temperature = temperature;
  if (json) { body.response_format = { type: "json_object" }; if (provider !== "openai") body.enable_thinking = false; }
  const r = await timedFetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
  const p = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(p?.error?.message || p?.message || `${provider} error ${r.status}`);
  return (p?.choices?.[0]?.message?.content || "").trim();
}

// Embeddings — OpenAI text-embedding-3-small exclusively (skill: never substitute).
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
const VERIFIER_TEXT = "lead-url-lens-vault-verifier";
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

/* ---- small hash for caching the compiled ICP / location results ---- */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
