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
// Qualification is purely score-based: score >= threshold → "qualified", below (and
// NOT COMPUTED) → "unqualified". No verdict override.
export const QUALIFICATION_THRESHOLD = 75;
export const SCORE_CSV_HEADERS = [
  "Full Name", "Job Title", "Job Section", "Headline", "Company", "Company Industry", "Company Headcount", "Location",
  "ICP Search Score", "Qualification", "ICP Match", "Matched ICP", "ICP Match Details",
  "Job Title (65)", "Job Section/Headline (20)", "Location (15)",
  "Note", "LinkedIn Url",
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
// Employer name after a "chez X" / "at X" / "@ X" marker in a single text, trimmed at
// the first descriptive separator. Used both as the Company column and as domain
// evidence (a firm literally named after the ICP's domain IS the domain).
export function companyByPreposition(text) {
  const m = normText(text).match(/(?:\bchez\s+|\bat\s+|@\s*)(.+)$/i);
  if (!m) return "";
  const c = m[1].split(/\s[-–—|•·]\s|[|•·]| - /)[0];
  return normText(c).replace(/[.,;:]+$/, "").slice(0, 80).trim();
}
// Company can appear in the Job Section, the Headline, or the Job Title — check all
// three (section first, then headline, then title) so brands like "@ C2P Recrutement"
// or "chez X" are captured wherever the person wrote them.
export function extractCompany(jobTitle, jobSection, headline) {
  for (const text of [jobSection, headline, jobTitle]) { const c = companyByPreposition(text); if (c) return c; }
  return "";
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
    company: normText(data.company) || extractCompany(job_title, job_section, headline),
    company_profile_url: String(data.company_profile_url || "").split(/[?#]/)[0].replace(/\/+$/, ""),
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
// Specific domain tokens of the ICP. The KEYWORDS define the domain (single-token
// keywords/variants directly; multi-token ones by their most specific, last token) —
// accepted titles' trailing tokens are role words ("des Opérations"), not domain, so
// they only serve as a fallback when the ICP defines no keywords at all. A lexical
// title hit through a value carrying no specific domain token only counts when one of
// these tokens appears somewhere on the prospect's card (domain corroboration). An ICP
// that defines no domain at all imposes no such constraint.
export function icpDomainInfo(icp) {
  const specific = new Set();
  const add = v => { const vt = contentTokens(v); if (vt.length === 1) specific.add(vt[0]); else if (vt.length >= 2) specific.add(vt[vt.length - 1]); };
  for (const k of icp.keywords) add(k);
  for (const k of (icp.keyword_variants || [])) add(k);
  if (!specific.size) for (const t of icp.job_titles) { const vt = contentTokens(t); if (vt.length >= 2) specific.add(vt[vt.length - 1]); }
  return { specific };
}
// Variant hygiene: Qwen-generated variants are kept only when they demonstrably relate
// to the ICP — sharing a content token with the accepted values — or when they are a
// known owner-operator equivalent. Everything else ("Talent Partner"-type strays that
// would produce unexplainable 100s) is discarded deterministically.
const OWNER_OPERATOR_VARIANTS = ["chef d'entreprise", "dirigeant", "gérant", "président", "président fondateur", "pdg", "ceo", "directeur général", "directrice générale", "managing director", "general manager", "owner", "founder", "fondateur", "co-fondateur", "cofondateur"];
export function filterKeywordVariants(variants, icp) {
  const base = new Set();
  for (const v of [...icp.job_titles, ...icp.keywords]) for (const t of contentTokens(v)) base.add(t);
  return [...new Set(variants)].filter(v => {
    const vt = contentTokens(v);
    if (!vt.length) return false;
    return vt.length === 1 || vt.some(t => base.has(t));
  }).slice(0, 80);
}
export function filterTitleVariants(variants, icp) {
  const base = new Set();
  for (const v of [...icp.job_titles, ...icp.keywords, ...(icp.keyword_variants || [])]) for (const t of contentTokens(v)) base.add(t);
  const owner = new Set(OWNER_OPERATOR_VARIANTS.map(v => contentTokens(v).join(" ")));
  return [...new Set(variants)].filter(v => {
    const vt = contentTokens(v);
    if (!vt.length) return false;
    return vt.some(t => base.has(t)) || owner.has(vt.join(" "));
  }).slice(0, 80);
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
  const system = `You expand accepted ICP values for lead scoring, in any industry. For each accepted job title and keyword, generate close variants a matching profile might display instead: common synonyms, standard abbreviations (e.g. "VP" / "Vice President"), and translations between the ICP's languages (at minimum French and English). For every role word in a gendered language ALWAYS include all gender forms (Fondateur AND Fondatrice, Directeur AND Directrice) and common plurals. For role-plus-domain titles, include BOTH the short role form and the role-plus-domain form. Include owner-operator equivalents ("Chef d'entreprise", "Dirigeant", "Gérant", "Président", "CEO", "Directeur Général") ONLY when they are strictly equivalent to an accepted role's seniority and function (e.g. the ICP targets founders/owners). As keyword_variants, also include the essential single-token domain words extracted from the accepted values (e.g. the domain noun of a role-plus-domain phrase). Never broaden to a different role, a different industry, or a more junior/senior level. Output ONLY a JSON object: {"job_title_variants":["…"],"keyword_variants":["…"]} containing ONLY the new variants (not the originals).`;
  const user = JSON.stringify({ job_titles: icp.job_titles, keywords: icp.keywords });
  return { system, user, max_tokens: 1800, temperature: 0, json: true };
}
/* ------------------------- Full ICP (remaining fields) → ICP Match ------------------------- */
// Compile the WHOLE ICP document into per-ICP structures for the remaining fields the
// search score does not cover (industry, headcount band, compound AND-keyword groups).
// Generic: works for one or many ICPs of any industry; fields an ICP omits are skipped.
export function compileFullIcpPrompt(icpText) {
  const system = `You convert an Ideal Customer Profile (ICP) document into a strict JSON schema for deterministic COMPANY matching. The document may define ONE or MORE ICPs. Extract ONLY each ICP's company Industry and company Headcount; never invent. Output ONLY JSON:
{"icps":[{"name":"<short name>","industries":["<industry label>", "..."],"headcount_min":<int|null>,"headcount_max":<int|null>}]}
Rules: a headcount like "11-50 employés" → headcount_min 11, headcount_max 50; "1-50 employés" → 1,50. Use [] for industries an ICP does not state and null for a missing headcount bound. Ignore job titles, keywords and location — those are handled elsewhere.`;
  return { system, user: `ICP document:\n${icpText}`, max_tokens: 900, temperature: 0, json: true };
}
// Parse a LinkedIn headcount text ("11-50 employés", "0-1 employés", "10 000+ employés").
export function parseHeadcountRange(text) {
  const t = fold(text);
  const num = s => parseInt(String(s).replace(/[^\d]/g, ""), 10);
  let m = t.match(/(\d[\d\s.,]*)\s*[-–à]\s*(\d[\d\s.,]*)/);
  if (m) return { min: num(m[1]), max: num(m[2]) };
  m = t.match(/(\d[\d\s.,]*)\s*\+/);
  if (m) return { min: num(m[1]), max: null };
  m = t.match(/(\d[\d\s.,]*)\s*(?:employe|salarie|membre)/);
  if (m) return { min: num(m[1]), max: num(m[1]) };
  return null;
}
export function headcountOverlaps(range, min, max) {
  if (!range) return null;
  const lo = range.min ?? 0, hi = range.max ?? Infinity;
  return hi >= (min ?? 0) && lo <= (max ?? Infinity);
}
// Tolerant industry match: LinkedIn's Secteur labels rarely equal ICP wording
// ("Recrutement et placement de personnel" vs "Recrutement et intérim"), so match on
// shared significant tokens; null = unresolved (caller may normalize via cached Qwen).
export function industryTokensMatch(pageIndustry, accepted) {
  const pt = new Set(contentTokens(pageIndustry));
  if (!pt.size) return null;
  for (const a of accepted) for (const t of contentTokens(a)) if (t.length > 3 && pt.has(t)) return true;
  return null;
}
// Parse LinkedIn relative timestamps ("3 j", "5 h", "1 sem.", "2 semaines", "3d", "1w",
// "2 mois") into age in days; null when unparseable.
export function parseRelativeAgeDays(text) {
  const t = fold(text);
  const m = t.match(/(\d+)\s*(min|h\b|heure|j\b|jour|d\b|day|sem|w\b|week|mois|mo\b|month|an\b|y\b|year)/);
  if (!m) return null;
  const n = parseInt(m[1], 10), u = m[2];
  if (/^min/.test(u)) return n / 1440;
  if (/^h/.test(u)) return n / 24;
  if (/^(j|jour|d|day)/.test(u)) return n;
  if (/^(sem|w|week)/.test(u)) return n * 7;
  if (/^(mois|mo|month)/.test(u)) return n * 30;
  return n * 365;
}
// ICP Match on the remaining ICP structural fields ONLY: company Industry AND company
// Headcount (job title + keywords are handled by the search score, not here). For each
// compiled ICP, every field that ICP defines must pass; an ICP defining neither field
// passes trivially. TRUE if at least one ICP passes. industryOkByIcp[i] carries any
// cached Qwen industry normalization the caller resolved. Deterministic.
export function evaluateIcpMatch({ companyIndustry = "", companyHeadcountText = "", industryOkByIcp = [] }, fullIcp) {
  const icps = (fullIcp && fullIcp.icps) || [];
  if (!icps.length) return { match: "", matched_icp: "", details: "no_full_icp" };
  const range = parseHeadcountRange(companyHeadcountText);
  const failsAll = [];
  for (const [i, icp] of icps.entries()) {
    const inds = (icp.industries || []).map(normText).filter(Boolean);
    const hasHead = icp.headcount_min != null || icp.headcount_max != null;
    if (!inds.length && !hasHead) return { match: "TRUE", matched_icp: icp.name || `ICP ${i + 1}`, details: "no_structural_fields" };
    const fails = [];
    if (inds.length) {
      const ok = industryOkByIcp[i] === true || industryTokensMatch(companyIndustry, inds) === true;
      if (!ok) fails.push(companyIndustry ? "industry" : "industry_unknown");
    }
    if (hasHead) {
      const ok = headcountOverlaps(range, icp.headcount_min, icp.headcount_max);
      if (ok !== true) fails.push(range ? `headcount:${normText(companyHeadcountText)}∉${icp.headcount_min ?? 0}-${icp.headcount_max ?? "∞"}` : "headcount_unknown");
    }
    if (!fails.length) return { match: "TRUE", matched_icp: icp.name || `ICP ${i + 1}`, details: "" };
    failsAll.push(`${icp.name || `ICP ${i + 1}`}: ${fails.join(",")}`);
  }
  return { match: "FALSE", matched_icp: "", details: failsAll.join(" | ") };
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
// Lexical exact/whole-phrase match, inflection- and stopword-tolerant. Both sides are
// folded, tokenized, stripped of FR/EN function words, and normalized for standard
// French gender/plural endings ("Fondatrice" ≡ "Fondateur", "Directrices" ≡ "Directeur",
// "Consultante" ≡ "Consultant"). The accepted value's content tokens must then appear as
// a contiguous whole-token sequence in the text — tokens compare by equality, never by
// substring, so "directorate" still does not match "director". A lexical hit scores the
// term 1.0 without needing embeddings.
const LEXICAL_STOPWORDS = new Set(["a", "an", "and", "at", "au", "aux", "chez", "d", "dans", "de", "des", "du", "en", "et", "for", "in", "l", "la", "le", "les", "of", "or", "ou", "the", "to", "un", "une", "with"]);
// Negators: a role hit whose matched phrase is immediately preceded by one of these does
// not count ("Ex-Fondateur", "ancien directeur", "aspiring director", "futur CEO").
const NEGATORS = new Set(["ex", "ancien", "ancienne", "anciens", "anciennes", "anciennement", "former", "formerly", "aspiring", "futur", "future", "futurs", "futures", "past"]);
export function normalizeToken(token) {
  let t = token;
  if (t.length > 3 && t.endsWith("s")) t = t.slice(0, -1);                       // plural
  if (t.length > 5 && t.endsWith("trice")) t = t.slice(0, -5) + "teur";          // fondatrice→fondateur
  else if (t.length > 4 && t.endsWith("euse")) t = t.slice(0, -4) + "eur";       // vendeuse→vendeur
  else if (t.length > 3 && t.endsWith("ere")) t = t.slice(0, -3) + "er";         // conseillere→conseiller (accents folded)
  else if (t.length > 3 && t.endsWith("ive")) t = t.slice(0, -3) + "if";         // sportive→sportif
  else if (t.length > 4 && t.endsWith("e")) t = t.slice(0, -1);                  // consultante→consultant
  return t;
}
// Aligned {raw, norm} content tokens — raw kept so negation checks see the actual word.
export function tokenPairs(value) {
  return (fold(value).match(/[a-z0-9]+/g) || [])
    .filter(t => !LEXICAL_STOPWORDS.has(t))
    .map(t => ({raw: t, norm: normalizeToken(t)}));
}
export function contentTokens(value) { return tokenPairs(value).map(p => p.norm); }
const negatedAt = (pairs, i) => i > 0 && NEGATORS.has(pairs[i - 1].raw);
export function lexicalMatch(text, values) {
  const tp = tokenPairs(text);
  if (!tp.length) return false;
  for (const v of values) {
    const vt = contentTokens(v);
    if (!vt.length || (vt.length === 1 && vt[0].length < 2)) continue;
    for (let i = 0; i + vt.length <= tp.length; i++) {
      let hit = true;
      for (let j = 0; j < vt.length; j++) if (tp[i + j].norm !== vt[j]) { hit = false; break; }
      if (hit && !negatedAt(tp, i)) return true;
    }
  }
  return false;
}
// Ordered match within ONE field: value tokens appear in order with at most `maxGap`
// extra tokens between consecutive ones ("directeur ⟨exécutif⟩ cabinet recrutement",
// "directeur ⟨fed supply idf⟩ cabinet recrutement"). Start token must not be negated.
export function orderedGapMatch(text, valueTokens, maxGap = 3) {
  const tp = tokenPairs(text);
  if (!tp.length || !valueTokens.length) return false;
  for (let start = 0; start < tp.length; start++) {
    if (tp[start].norm !== valueTokens[0] || negatedAt(tp, start)) continue;
    let pos = start, ok = true;
    for (let j = 1; j < valueTokens.length; j++) {
      let found = -1;
      for (let k = pos + 1; k <= Math.min(tp.length - 1, pos + 1 + maxGap); k++) if (tp[k].norm === valueTokens[j]) { found = k; break; }
      if (found < 0) { ok = false; break; }
      pos = found;
    }
    if (ok) return true;
  }
  return false;
}
const hasToken = (text, tok) => tokenPairs(text).some(p => p.norm === tok);
const hasTokenGuarded = (text, tok) => { const tp = tokenPairs(text); return tp.some((p, i) => p.norm === tok && !negatedAt(tp, i)); };
// Best cosine of `text` against a list of accepted values, using the shared vector map.
function bestMatch(text, values, vectors) {
  const tv = vectors[normText(text)];
  if (!tv) return null; // embedding unavailable → caller decides NOT COMPUTED
  let best = 0;
  for (const v of values) { const ov = vectors[normText(v)]; if (ov) best = Math.max(best, cosine(tv, ov)); }
  return best;
}
// Title-term lexical evidence (generic, any industry — all rules derive from the ICP's
// accepted values). Three deterministic paths, strongest first:
//  1. TIGHT: an accepted value's tokens appear in order within ONE field (title,
//     headline, or section) with ≤3 extra tokens between consecutive ones — covers
//     exact phrases, intervening modifiers ("Directeur ⟨exécutif⟩ cabinet…") and
//     embedded brands ("Directeur ⟨Fed Supply IDF⟩ - Cabinet de recrutement").
//     Full hit, no forced review.
//  2. LOOSE (cross-field/scattered): the value's head role token matches in the title
//     or headline AND every remaining content token appears somewhere across
//     title+section+headline. Full hit + forced advisory review.
//  3. COMPANY DOMAIN: head role token matches in title/headline AND any remaining
//     token appears in the company name ("Dirigeante-Fondatrice chez Focus
//     Recrutement"). Full hit + forced advisory review.
// All head/phrase matches are negation-guarded (ex/ancien/former/aspiring/futur).
export function titleLexicalEvidence(rf, titleValues, domain = { specific: new Set() }) {
  const fields = [rf.job_title, rf.headline, rf.job_section].map(normText).filter(Boolean);
  if (!fields.length) return { hit: false, review: false };
  const companyText = normText(rf.company || "");
  const allText = fields.join(" ") + (companyText ? " " + companyText : "");
  // Domain corroboration: with no domain defined, the ICP imposes no constraint.
  const noDomain = domain.specific.size === 0;
  const cardHasSpecific = noDomain || [...domain.specific].some(t => hasToken(allText, t));
  const roleFields = [rf.job_title, rf.headline].map(normText).filter(Boolean);
  let best = null;
  const accept = review => { if (best === null || (best.review && !review)) best = { review }; };
  for (const v of titleValues) {
    const vt = contentTokens(v);
    if (!vt.length) continue;
    const valueHasSpecific = noDomain || vt.some(t => domain.specific.has(t));
    if (vt.length === 1) {
      if (vt[0].length >= 2 && fields.some(f => hasTokenGuarded(f, vt[0]))) {
        if (valueHasSpecific) accept(false);                 // self-evident
        else if (cardHasSpecific) accept(true);              // role-only, corroborated → review
      }
      continue;
    }
    if (fields.some(f => orderedGapMatch(f, vt, 3))) {
      if (valueHasSpecific) accept(false);
      else if (cardHasSpecific) accept(true);
      continue;
    }
    const head = vt[0], rest = vt.slice(1);
    if (!roleFields.some(f => hasTokenGuarded(f, head))) continue;
    if (!valueHasSpecific && !cardHasSpecific) continue;
    if (rest.every(t => hasToken(allText, t))) accept(true);
    else if (companyText && hasToken(companyText, vt[vt.length - 1])) accept(true); // most specific token in company name
  }
  return best ? { hit: true, review: best.review } : { hit: false, review: false };
}
// Score one captured row against the ICP. `vectors` maps normalized text → embedding.
// Returns {score, job_title, job_section_headline, location, needs_review} where score
// is an integer 0–100 or "NOT COMPUTED" when a required semantic embedding could not be
// produced. needs_review marks weak-evidence (cross-field/company) title matches for a
// forced advisory Qwen review — the number itself never changes.
export function scoreRow(rf, icp, vectors, locationScore) {
  const jobTitleText = rf.job_title || "";
  const headlineText = normText(rf.headline || "");
  const sectionHeadlineText = normText(`${rf.job_section} ${rf.headline}`);
  const titleValues = [...new Set([...icp.job_titles, ...(icp.job_title_variants || [])])];
  const semanticValues = [...new Set([...titleValues, ...icp.keywords, ...(icp.keyword_variants || [])])];
  const domain = icpDomainInfo(icp);
  let needs_review = false, title_from_embeddings = false;

  // Job Title (65): domain-corroborated lexical evidence over title+headline(+section),
  // else calibrated best-cosine over BOTH the extracted title and the headline.
  let jt = 0;
  if (icp.job_titles.length) {
    const ev = titleLexicalEvidence(rf, titleValues, domain);
    if (ev.hit) { jt = 1.0; needs_review = ev.review; }
    else {
      title_from_embeddings = true;
      const candidates = [jobTitleText, headlineText].filter(Boolean);
      if (!candidates.length) candidates.push(sectionHeadlineText);
      let best = null;
      for (const c of candidates) { const b = bestMatch(c, titleValues, vectors); if (b !== null) best = Math.max(best ?? 0, b); }
      jt = calibrate(best);
    }
  }
  // Job Section/Headline (20): section+headline text vs accepted titles ∪ keywords (∪ variants).
  let jsh = 0;
  if (semanticValues.length) {
    if (lexicalMatch(sectionHeadlineText || jobTitleText, semanticValues)) jsh = 1.0;
    else jsh = calibrate(bestMatch(sectionHeadlineText || jobTitleText, semanticValues, vectors));
  }
  if (jt === null || jsh === null) {
    return { score: "NOT COMPUTED", job_title: null, job_section_headline: null, location: locationScore, needs_review: false, title_from_embeddings };
  }
  const loc = icp.locations.length ? (Number.isFinite(locationScore) ? locationScore : 0) : 0;
  const total = WEIGHTS.job_title * (jt || 0) + WEIGHTS.job_section_headline * (jsh || 0) + WEIGHTS.location * loc;
  return {
    score: Math.max(0, Math.min(100, Math.round(total * 100))),
    job_title: jt || 0,
    job_section_headline: jsh || 0,
    location: loc,
    needs_review,
    title_from_embeddings,
  };
}
// R6: canonical-URL dedupe safeguard applied at CSV build time.
export function dedupeRows(rows) {
  const seen = new Set(), out = [];
  for (const r of rows) {
    const key = fold(canonicalUrl(r.linkedin_url || "")) || `${fold(r.full_name)}|${fold(r.headline)}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(r);
  }
  return out;
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
export function qualification(score) {
  return Number.isFinite(Number(score)) && Number(score) >= QUALIFICATION_THRESHOLD ? "qualified" : "unqualified";
}
export function buildScoreCsv(rows) {
  const lines = [SCORE_CSV_HEADERS.join(";")];
  for (const r of rows) {
    lines.push([
      r.full_name, r.job_title, r.job_section, r.headline, r.company || "", r.company_industry || "", r.company_headcount || "", r.location,
      r.icp_score, qualification(r.icp_score), r.icp_match || "", r.matched_icp || "", r.icp_match_details || "",
      pct(r.c_job_title), pct(r.c_job_section_headline), pct(r.c_location),
      r.note || "", r.linkedin_url,
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
