/* TechNFirms Lead URL Lens — Feed pipeline helpers.
 *
 * Pure, side-effect-free logic for the "Feed" workflow: parse a LINKS_TO_ANALYZE.md
 * file into LinkedIn profile URLs, score each captured profile against an ICP
 * definition, and — for qualifying profiles — build a persona card and three
 * outreach messages. All model reasoning is grounded strictly in the facts the
 * extension captured from LinkedIn; the prompts forbid inventing data.
 *
 * The three "skills" are implemented here as editable prompt builders so their
 * output can be saved verbatim per row:
 *   - icpScoringPrompt      → ICP Score          (skill: icp-profile-scoring)
 *   - personaPrompt         → Persona Card + Opportunity Score (skill: persona-framework)
 *   - outreachPrompt        → Outreach 1/2/3      (skill: email-outreach)
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

/* ------------------------------------------------------------------ parsing */

// Extract canonical LinkedIn profile URLs from a Markdown / text file, in order,
// de-duplicated. Handles bare URLs, Markdown links [text](url), and list items.
export function parseProfileLinks(text) {
  const urls = [];
  const seen = new Set();
  const pattern = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in\/[^\s)"'<>]+|sales\/lead\/[^\s)"'<>]+)/gi;
  for (const raw of String(text || "").match(pattern) || []) {
    const canonical = canonicalProfileUrl(raw);
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      urls.push(canonical);
    }
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
  } catch {
    return "";
  }
}

/* ------------------------------------------------------- fact preparation */

// Reduce a captured profile object to the observed facts the model may reason
// over. Nothing here is invented — every field comes from the DOM capture.
export function factsForProfile(data = {}) {
  const facts = {
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
      role: item.role_headline || "",
      company: item.company || "",
      start: item.role_start_date || "",
      end: item.role_is_current ? "present" : (item.role_end_date || ""),
      description: (item.role_description || "").slice(0, 600),
    })),
    company: data.company_page ? {
      name: data.company_page.company_name || data.company || "",
      industry: data.company_page.industry || "",
      size: data.company_page.company_size || "",
      headquarters: data.company_page.headquarters || "",
      website: data.company_page.website || data.company_website_candidate || "",
      description: (data.company_page.description || "").slice(0, 800),
    } : { name: data.company || "" },
    recent_posts: (data.posts || []).map(p => (p.content || "").slice(0, 700)).filter(Boolean).slice(0, 7),
    recent_comments: (data.comments || []).map(c => (c.content || "").slice(0, 500)).filter(Boolean).slice(0, 5),
  };
  return facts;
}

/* --------------------------------------------------------------- prompts */

const GROUNDING = "Use ONLY the facts in FACTS. Never invent an employer, headcount, budget, tenure, seniority, or intent that is not present. When a fact is unknown, write \"not observed\" rather than guessing.";

// Skill: icp-profile-scoring
export function icpScoringPrompt(icpText, facts) {
  const system = `You score how well a LinkedIn profile fits an Ideal Customer Profile (ICP). ${GROUNDING}
Return ONLY a JSON object, no prose, no markdown fences:
{"icp_score": <integer 0-100>, "justification": "<=60 words citing only observed facts>"}
Score conservatively when facts are sparse. 0 = no fit, 100 = perfect fit.`;
  const user = `ICP DEFINITION:\n${icpText}\n\nFACTS:\n${JSON.stringify(facts)}`;
  return { system, user, max_tokens: 600 };
}

// Skill: persona-framework
export function personaPrompt(icpText, facts) {
  const system = `You are a B2B persona analyst. Using the persona framework, produce a concise persona card for the prospect. ${GROUNDING}
Return ONLY a JSON object, no prose, no markdown fences:
{
  "persona_card": "<markdown persona card covering: Role & seniority, Likely goals, Likely pains, Buying trigger, Decision role — each line grounded in an observed fact; use 'not observed' where unknown>",
  "opportunity_score": <integer 0-100>,
  "opportunity_rationale": "<=40 words, observed facts only>"
}
opportunity_score reflects how strong and timely the outreach opportunity is based on observed signals (recent activity, role change, hiring, growth). Be conservative without evidence.`;
  const user = `ICP DEFINITION:\n${icpText}\n\nFACTS:\n${JSON.stringify(facts)}`;
  return { system, user, max_tokens: 1500 };
}

// Skill: email-outreach
export function outreachPrompt(icpText, facts, personaCard) {
  const system = `You are a B2B outreach copywriter. Write three distinct, personalized outreach messages for the prospect. ${GROUNDING}
- Message 1: a short connection opener referencing one specific observed fact.
- Message 2: a value-led follow-up tying the ICP's offer to an observed pain or goal.
- Message 3: a direct, respectful call-to-action.
Each message <=90 words. No fabricated claims about the prospect or their company. Do not use bracket placeholders unless the underlying fact is genuinely "not observed".
Return ONLY a JSON object, no prose, no markdown fences:
{"outreach_1": "<message 1>", "outreach_2": "<message 2>", "outreach_3": "<message 3>"}`;
  const user = `ICP DEFINITION:\n${icpText}\n\nPERSONA CARD:\n${personaCard}\n\nFACTS:\n${JSON.stringify(facts)}`;
  return { system, user, max_tokens: 1800 };
}

/* --------------------------------------------------------------- LLM call */

// Call the configured LLM provider and return the assistant's text.
// Supported providers: "anthropic" (default), "openai".
export async function callLLM({ provider = "anthropic", apiKey, model, system, user, max_tokens = 1024 }) {
  if (!apiKey) throw new Error("LLM API key is required for the Feed workflow.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    if (provider === "openai") {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || "gpt-4o",
          max_tokens,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || `OpenAI error ${response.status}`);
      return payload?.choices?.[0]?.message?.content || "";
    }
    // Anthropic (default)
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: model || "claude-opus-4-8",
        max_tokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `Anthropic error ${response.status}`);
    return (payload?.content || []).filter(block => block.type === "text").map(block => block.text).join("").trim();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("LLM request timed out after 120s.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Parse a JSON object out of a model response, tolerating markdown fences or
// leading prose. Returns null if nothing parseable is found.
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {}
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {}
  }
  return null;
}

/* --------------------------------------------------------------- CSV */

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Build the enriched CSV. Each row maps 1:1 to a LINKS_TO_ANALYZE.md URL and
// carries the verbatim skill output in its cell.
export function buildFeedCsv(rows) {
  const lines = [FEED_CSV_HEADERS.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push([
      row.url,
      row.icp_score,
      row.persona_card,
      row.opportunity_score,
      row.outreach_1,
      row.outreach_2,
      row.outreach_3,
    ].map(csvCell).join(","));
  }
  // Prepend a UTF-8 BOM so Excel opens accented characters correctly.
  return "﻿" + lines.join("\r\n");
}

export function csvDataUrl(csv) {
  return "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
}
