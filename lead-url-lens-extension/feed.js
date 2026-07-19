/* TechNFirms Lead URL Lens — Feed pipeline (recruitment-niche skills).
 *
 * Implements three skills faithfully, tuned for maximum efficiency:
 *   - icp-scoring       → embeddings cosine + hard structural rules, ALL math in
 *                         code (never the LLM), producing the standardized
 *                         "LinkedIn Profile ICP Analysis Report".
 *   - persona-framework → 6-section Persona Card + 30/40/30 Opportunity Score.
 *   - email-outreach    → 3 French emails (Pattern Interrupt / Value-Add Nudge /
 *                         Diagnostic Break-up).
 *
 * Efficiency: ICP scoring costs only embeddings (2 ICP vectors embedded once per
 * run + 1 per profile). LLM (Qwen) reasoning runs ONLY for profiles at/above the
 * threshold, and persona + the 3 emails are produced in a SINGLE combined call.
 *
 * Secrets (Qwen key, Embeddings key) are AES-GCM encrypted at rest and never
 * returned to the UI. See encryptSecret / decryptSecret.
 */

export const FEED_CSV_HEADERS = [
  "URL",
  "ICP Score",
  "Persona Card",
  "Opportunity Score",
  "Outreach 1",
  "Outreach 2",
  "Outreach 3",
];

/* ICP keyword vectors — verbatim from the icp-scoring skill (Phase 2). */
export const ICP1_VECTOR_TEXT = "Fondateur, Co-fondateur, Gérant, Managing Partner, Directeur d'agence, Directeur des Opérations, cabinet de recrutement, chasseur de tête, conseil en recrutement, croissance, IA, automatisation, RGPD, conformité";
export const ICP2_VECTOR_TEXT = "Associé, Partner, Fondateur, Directeur de cabinet, Directeur Général, cabinet de chasse, executive search, recherche de cadres, headhunting, cabinet de recrutement spécialisé, nous recrutons, développement, digital";

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

/* ------------------------------------------------------- fact preparation */
export function factsForProfile(data = {}) {
  return {
    profile_url: data.profile_url || "",
    full_name: data.full_name || "",
    headline: data.headline || "",
    location: data.location || "",
    current_role: data.role_headline || data.role || "",
    current_company: data.company || "",
    role_is_current: Boolean(data.role_is_current),
    role_start_date: data.role_start_date || "",
    role_description: data.role_description || "",
    experience_history: (data.experience_history || []).slice(0, 8).map(item => ({
      role: item.role_headline || "", company: item.company || "",
      start: item.role_start_date || "", end: item.role_is_current ? "present" : (item.role_end_date || ""),
      description: (item.role_description || "").slice(0, 600),
    })),
    company: data.company_page ? {
      name: data.company_page.company_name || data.company || "",
      industry: data.company_page.industry || "",
      size: data.company_page.company_size || "",
      headquarters: data.company_page.headquarters || "",
      website: data.company_page.website || data.company_website_candidate || "",
      specialties: data.company_page.specialties || "",
      description: (data.company_page.description || "").slice(0, 800),
    } : { name: data.company || "", size: "", industry: "", headquarters: "" },
    recent_posts: (data.posts || []).map(p => (p.content || "").slice(0, 700)).filter(Boolean).slice(0, 5),
    recent_comments: (data.comments || []).map(c => (c.content || "").slice(0, 500)).filter(Boolean).slice(0, 7),
  };
}

// Minimal Semantic Payload (icp-scoring Phase 1) as one embeddable string.
export function profileEmbeddingText(facts) {
  return [facts.headline, facts.current_role, facts.current_company, facts.role_description,
    (facts.experience_history || []).map(e => `${e.role} ${e.company}`).join(" ")]
    .filter(Boolean).join(". ").slice(0, 2000) || facts.full_name || "profile";
}

/* --------------------------------------------------- structural validation */
export function parseHeadcount(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/ /g, " ");
  const nums = (cleaned.replace(/(\d)\s+(\d)/g, "$1$2").match(/\d+/g) || []).map(Number);
  if (!nums.length) return null;
  if (nums.length >= 2) return { min: nums[0], max: nums[1] };
  if (/\+|plus|more|au[- ]?del[àa]/i.test(cleaned)) return { min: nums[0], max: Infinity };
  return { min: nums[0], max: nums[0] };
}
// icp-scoring Phase 4: ICP target 1-50 (exact 25), 51-200 adjacent (10), >200 none (0).
export function headcountScore(range) {
  if (!range) return { points: 0, label: "NO MATCH (unknown)" };
  if (range.min <= 50) return { points: 25, label: "EXACT" };
  if (range.min <= 200) return { points: 10, label: "ADJACENT" };
  return { points: 0, label: "NO MATCH" };
}
const FRANCE_RE = /\b(france|paris|lyon|marseille|toulouse|bordeaux|lille|nantes|strasbourg|nice|rennes|montpellier|grenoble|[îi]le[- ]de[- ]france|fran[çc]ais)\b/i;
const HR_RE = /(ressources humaines|recrutement|recruitment|staffing|chasse de t[êe]te|executive search|human resources|\bhr\b|int[ée]rim|conseil en recrutement|headhunt)/i;
export function locationIndustryScore(facts) {
  const c = facts.company || {};
  const locText = [facts.location, c.headquarters, c.description].filter(Boolean).join(" ");
  const indText = [c.industry, c.specialties, facts.headline, facts.current_role, c.description, c.name].filter(Boolean).join(" ");
  const france = FRANCE_RE.test(locText) || FRANCE_RE.test(indText);
  const industry = HR_RE.test(indText);
  return { points: france && industry ? 15 : (france || industry ? 5 : 0), france, industry };
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0, n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Compute the full ICP score in CODE (skill rule: the LLM never calculates scores).
export function computeIcp(facts, profileVec, icp1Vec, icp2Vec) {
  const s1 = cosine(profileVec, icp1Vec), s2 = cosine(profileVec, icp2Vec);
  const maxSem = Math.max(0, Math.min(1, Math.max(s1, s2)));
  const semantic = Math.round(maxSem * 60);
  const range = parseHeadcount(facts.company?.size);
  const hc = headcountScore(range);
  const li = locationIndustryScore(facts);
  return {
    s1: Math.max(0, s1), s2: Math.max(0, s2), maxSem, semantic,
    headcount: hc.points, headcountLabel: hc.label,
    locind: li.points, france: li.france, industry: li.industry,
    total: Math.round(semantic + hc.points + li.points),
    primary: s1 >= s2 ? "ICP 1 (Scaling Cabinet)" : "ICP 2 (Niche/Exec Search)",
  };
}
export function verdictBand(total) {
  if (total >= 80) return "HOT"; if (total >= 60) return "WARM"; if (total >= 40) return "COLD"; return "REJECT";
}
function icpRecommendation(v, r) {
  const miss = [];
  if (r.headcount < 25) miss.push("headcount outside 1-50");
  if (!r.france) miss.push("location not confirmed in France");
  if (!r.industry) miss.push("industry not clearly HR/recruitment");
  if (r.semantic < 36) miss.push("weak semantic alignment");
  const gap = miss.length ? ` Watch-out: ${miss.join("; ")}.` : "";
  const angle = { HOT: "Immediate personalised outreach referencing their strongest ICP signal.",
    WARM: "Cautious outreach; lead with the ICP match and address the gap.",
    COLD: "Nurture only; engage with their content before any pitch.",
    REJECT: "Discard — not an ICP match." }[v];
  return `${angle}${gap}`;
}
export function buildIcpReport(facts, r, cacheStatus) {
  const v = verdictBand(r.total);
  const c = facts.company || {};
  return `====================================================================
 LINKEDIN PROFILE ICP ANALYSIS REPORT
====================================================================
1. PROFILE IDENTITY & EXTRACTED DATA
- Full Name: ${facts.full_name || "N/A"}
- Current Title: ${facts.current_role || facts.headline || "N/A"}
- Company Name: ${facts.current_company || "N/A"}
- Profile Preview/Description Summary: ${(facts.headline || "N/A").slice(0, 220)}
- Minimal Semantic Payload Extracted: ${profileEmbeddingText(facts).slice(0, 240)}

2. COMPANY CONTEXT & CACHE STATUS
- Company Name: ${facts.current_company || "N/A"}
- Employee Count: ${c.size || "Unknown"}
- Cache Status: ${cacheStatus || "MISS & UPDATED"}
- Industry Detected: ${c.industry || (r.industry ? "HR/Recruitment (inferred)" : "Unknown")}
- Location Detected: ${facts.location || c.headquarters || "Unknown"}

3. SEMANTIC EMBEDDING ANALYSIS
- Vector ICP 1 (Scaling Cabinet) Similarity: ${r.s1.toFixed(2)}
- Vector ICP 2 (Niche/Exec Search) Similarity: ${r.s2.toFixed(2)}
- Primary ICP Match: ${r.primary}
- Semantic Alignment Notes: max cosine ${r.maxSem.toFixed(2)} -> ${r.semantic}/60

4. STRUCTURAL VALIDATION (HARD FILTERS)
- Location Match (France): ${r.france ? "YES" : "NO"}
- Industry Match (HR/Recruitment): ${r.industry ? "YES" : "NO"}
- Headcount Match (1-50 or 11-50): ${r.headcountLabel}

5. FINAL ICP SCORE & VERDICT
- Semantic Score: ${r.semantic} / 60
- Headcount Score: ${r.headcount} / 25
- Location/Industry Score: ${r.locind} / 15
--------------------------------------------------------------------
TOTAL ICP SCORE: [ ${r.total} / 100 ]
====================================================================
ACTIONABLE VERDICT: ${v}
AGENT RECOMMENDATION:
${icpRecommendation(v, r)}
====================================================================`;
}

/* ------------------------------------------------- persona + outreach prompt */
const PERSONA_TEMPLATE = `SECTION 1: CORE IDENTITY & PROFESSIONAL DNA
- Full Name:
- Current Title:
- Company:
- Company Size & Industry:
- Location:
- Tenure in Current Role:
- Career Trajectory Summary:
- Core KPIs / Responsibilities:

SECTION 2: BEHAVIORAL & MINDSET PROFILE (Phase 2)
- Content Themes (from X posts):
- Communication Style & Tone:
- Peer Interaction & Values (from 12-X comments):
- Stated Beliefs / Philosophies:

SECTION 3: ORGANIZATIONAL CONTEXT (Phase 3)
- Company Value Proposition:
- Strategic Focus / Current Goals:
- Company Culture & Vibe:
- Internal Gaps / Hiring Needs:
- Tech Stack / Tools Mentioned:

SECTION 4: PAIN POINTS & BUYING TRIGGERS
- Primary Operational Pains:
- Strategic / Business Pains:
- Hidden Objections / Fears:
- Recent Trigger Events:

SECTION 5: ALIGNMENT WITH OUR OFFER
- Dream Outcome for THIS Persona:
- How Our Offer Solves Their Specific Pain:
- Required Proof to Convert:

SECTION 6: THE OPPORTUNITY SCORE (0-100) — calculate last
- ICP Fit Score: [__/30]
- Pain & Trigger Score: [__/40]
- Authority & Budget Score: [__/30]
- TOTAL OPPORTUNITY SCORE: [ XX / 100 ]

Final Strategic Note: [1-2 sentences on the single best angle to approach this person]`;

// One combined call → Persona Card + Opportunity Score + the 3 outreach emails.
export function personaOutreachPrompt(icpText, offerText, facts, icpReport) {
  const system = `You are a B2B research + copywriting agent selling the French "Recruteur Augmenté" AI offer to recruitment cabinets. Ground everything in the FACTS, the ICP DEFINITION, the ICP REPORT, and the OFFER. Use ONLY observed facts — never invent an employer, headcount, tenure, budget, or intent. Where data is missing, write "Data unavailable, inferred as [X]" rather than omitting the field.

STEP 1 — Persona Card. Fill EVERY field of this exact template and section headings; behavioral fields draw on the ~5 recent posts and ~7 comments in FACTS:
${PERSONA_TEMPLATE}
Compute SECTION 6 LAST: ICP Fit /30, Pain & Trigger Alignment /40, Authority & Budget /30 → total /100.

STEP 2 — Three cold emails in FRENCH, peer-to-peer tone ("nous avons remarqué", "beaucoup de gérants nous disent"), each a Subject line then body. Fill the hook from persona §2/§3, the pain from §4, the proof from §5, and tie value to the Offer's dream outcome + CNIL/RGPD compliance and the "10h/semaine" gain:
- outreach_1 "Pattern Interrupt": 3-second hook proving research, specific value prop (≈60% admin time, CNIL fear), humility ("l'objectif n'est pas de remplacer vos consultants"), low-friction 15-min CTA.
- outreach_2 "Value-Add Nudge" (3-4 days later): shorter, a diagnostic question, offer a "exemple concret de 2 minutes", "sinon, aucun souci".
- outreach_3 "Diagnostic Break-up" (5-7 days later): graceful close, loss aversion ("je clos ce dossier"), door left open.

Return ONLY a JSON object, no markdown fences:
{"persona_card":"<full persona card text>","opportunity_score":<integer 0-100>,"outreach_1":"<Subject: … + body>","outreach_2":"<Subject: … + body>","outreach_3":"<Subject: … + body>"}`;
  const user = `ICP DEFINITION:\n${icpText || "(not provided)"}\n\nOFFER:\n${offerText || "(not provided)"}\n\nICP REPORT:\n${icpReport}\n\nFACTS:\n${JSON.stringify(facts)}`;
  return { system, user, max_tokens: 4000 };
}

/* --------------------------------------------------------------- LLM + embeddings */
// DashScope has two regions; the toggle selects the base host for Qwen calls.
const DASHSCOPE = { intl: "https://dashscope-intl.aliyuncs.com", cn: "https://dashscope.aliyuncs.com" };
const QWEN_CHAT_MODEL = "qwen-plus", QWEN_EMBED_MODEL = "text-embedding-v3";
const OPENAI_CHAT = { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" };
const OPENAI_EMBED = { url: "https://api.openai.com/v1/embeddings", model: "text-embedding-3-small" };
const qwenBase = region => DASHSCOPE[region] || DASHSCOPE.intl;

async function timedFetch(url, options, ms = 120000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (e) { if (e?.name === "AbortError") throw new Error("Request timed out."); throw e; }
  finally { clearTimeout(timer); }
}

// Chat completion. providers: "qwen" (default), "openai", "anthropic". region applies to qwen.
export async function chatLLM({ provider = "qwen", apiKey, model, region = "intl", system, user, max_tokens = 1024 }) {
  if (!apiKey) throw new Error("LLM API key is required.");
  if (provider === "anthropic") {
    const r = await timedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: model || "claude-opus-4-8", max_tokens, system, messages: [{ role: "user", content: user }] }),
    });
    const p = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(p?.error?.message || `Anthropic error ${r.status}`);
    return (p?.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  }
  const url = provider === "openai" ? OPENAI_CHAT.url : `${qwenBase(region)}/compatible-mode/v1/chat/completions`;
  const defModel = provider === "openai" ? OPENAI_CHAT.model : QWEN_CHAT_MODEL;
  const r = await timedFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model || defModel, max_tokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  const p = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(p?.error?.message || p?.message || `${provider} error ${r.status}`);
  return (p?.choices?.[0]?.message?.content || "").trim();
}

// Embeddings. providers: "qwen" (text-embedding-v3), "openai" (text-embedding-3-small). region applies to qwen.
export async function embed(texts, { provider = "qwen", apiKey, model, region = "intl" } = {}) {
  if (!apiKey) throw new Error("Embeddings API key is required.");
  const url = provider === "openai" ? OPENAI_EMBED.url : `${qwenBase(region)}/compatible-mode/v1/embeddings`;
  const defModel = provider === "openai" ? OPENAI_EMBED.model : QWEN_EMBED_MODEL;
  const r = await timedFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model || defModel, input: texts }),
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

/* --------------------------------------------------------------- CSV */
function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function buildFeedCsv(rows) {
  const lines = [FEED_CSV_HEADERS.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push([row.url, row.icp_score, row.persona_card, row.opportunity_score, row.outreach_1, row.outreach_2, row.outreach_3].map(csvCell).join(","));
  }
  return "﻿" + lines.join("\r\n");
}
export function csvDataUrl(csv) { return "data:text/csv;charset=utf-8," + encodeURIComponent(csv); }

/* ---------------------------- passphrase-gated key vault (PBKDF2 + AES-GCM) */
// Keys are encrypted with a key derived from a user passphrase that is NEVER
// stored. The derived AES key is held only in memory (chrome.storage.session)
// for the browser session, so keys survive service-worker restarts but require
// re-unlocking after the browser closes.
export const KDF_ITERATIONS = 210000;
const VERIFIER_TEXT = "lead-url-lens-vault-verifier";
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveAesKey(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: KDF_ITERATIONS, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}
// Derive a vault key from a passphrase. Pass saltB64 to reuse an existing salt.
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
