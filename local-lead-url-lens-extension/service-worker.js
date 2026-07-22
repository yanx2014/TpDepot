/* Local Lead URL Lens — capture LinkedIn People Search prospects (same capture rules
 * as the CRM extension) and score them locally against your ICP with the fixed
 * Job Title 65 / Job Section·Headline 20 / Location 15 contract, then export a CSV.
 * No backend / CRM: OpenAI (embeddings) + optional Qwen keys live in a local
 * passphrase-gated vault; all scoring math is deterministic in code. */
import {
  canonicalProfileUrl, rowFieldsFromCapture, normText, fold, activeIcp, icpEmbedTexts,
  scoreRow, exactLocationScore, compileIcpPrompt, locationNormalizePrompt, expandIcpPrompt,
  qualification, buildScoreCsv, dedupeRows, filterTitleVariants, filterKeywordVariants, csvDataUrl, chatLLM, embed, extractJson, sha256Hex,
  compileFullIcpPrompt, industryTokensMatch, parseRelativeAgeDays, evaluateIcpMatch,
  deriveVaultKey, exportKeyRaw, importKeyRaw, encryptWithKey, decryptWithKey, makeVerifier,
  checkVerifier, KDF_ITERATIONS,
} from "./feed.js";

const MAX_TARGET = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let wakeLock = false;

/* ------------------------------------------------------------- durable state */
async function stored() { return (await chrome.storage.local.get("operationState")).operationState || {mode: "idle"}; }
async function save(patch) { const current = await stored(), next = {...current, ...patch, updated_at: new Date().toISOString()}; await chrome.storage.local.set({operationState: next}); return next; }
// Serialize state writes so the concurrent capture loop and match consumer can't lose
// each other's updates (read-modify-write is made atomic by chaining).
let ioChain = Promise.resolve();
function saveLocked(patch) { const p = ioChain.then(() => save(patch), () => save(patch)); ioChain = p.catch(() => {}); return p; }
// --- Background worker tab (ICP Match phase). Ported from the capture extension. ---
async function acquireLinkedInWorkerTab(preferredUrl = "https://www.linkedin.com/feed/") {
  const state = await stored();
  if (Number(state.workerTabId)) { try { const tab = await chrome.tabs.get(Number(state.workerTabId)); if (tab?.id && /^https:\/\/www\.linkedin\.com\//.test(tab.url || preferredUrl)) { try { await chrome.tabs.update(tab.id, {autoDiscardable: false}); } catch {} return {tab, owned: true}; } } catch {} }
  const tab = await chrome.tabs.create({url: preferredUrl, active: false});
  try { await chrome.tabs.update(tab.id, {autoDiscardable: false}); } catch {}
  await saveLocked({workerTabId: tab.id});
  return {tab, owned: true};
}
async function ensureProfileReceiver(tabId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { const response = await chrome.tabs.sendMessage(tabId, {type: "PROFILE_RECEIVER_PING"}); if (response?.ready) return true; } catch {}
    if (attempt === 2) try { await chrome.scripting.executeScript({target: {tabId}, files: ["experience-contract.js", "content.js"]}); } catch {}
    await sleep(250);
  }
  return false;
}
async function closeWorkerTab() { const state = await stored(), id = Number(state.workerTabId || 0); if (id) try { await chrome.tabs.remove(id); } catch {} await saveLocked({workerTabId: 0}); }

/* ------------------------------------------------------------- tab plumbing (same as capture extension) */
async function activeLinkedIn(searchOnly = false) {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true}), url = tab?.url || "";
  const accepted = searchOnly ? /^https:\/\/www\.linkedin\.com\/(?:search\/results\/people|sales\/search\/people)/.test(url) : /^https:\/\/www\.linkedin\.com\//.test(url);
  if (!tab?.id || !accepted) throw new Error(searchOnly ? "Open a LinkedIn People Search or Sales Navigator search first" : "Open an authenticated LinkedIn tab first");
  return tab;
}
async function waitLoaded(tabId, previousFingerprint = "") {
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await stored(); if (state.cancelled) throw new Error("cancelled");
    while ((await stored()).paused) await sleep(350);
    const tab = await chrome.tabs.get(tabId); if (tab.status === "complete") break; await sleep(250);
  }
  await sleep(previousFingerprint ? 260 : 180);
}
async function sendSearchMessage(tabId, message) {
  let ready = false;
  try { const response = await chrome.tabs.sendMessage(tabId, {type: "SEARCH_RECEIVER_PING"}); ready = response?.ready === true; } catch {}
  if (!ready) { await chrome.scripting.executeScript({target: {tabId}, files: ["search-content.js"]}); await sleep(150); }
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch (error) { throw new Error(`LinkedIn page receiver could not start. Reload the LinkedIn tab once, then retry. ${error.message}`); }
}
async function waitForSearchPageReady(tabId, expectedPage = 0) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const state = await stored(); if (state.cancelled) throw new Error("cancelled");
    while ((await stored()).paused) await sleep(250);
    try { const pageState = await sendSearchMessage(tabId, {type: "GET_SEARCH_PAGE_STATE"}); if (pageState?.ready && (!expectedPage || Number(pageState.page) === expectedPage)) return pageState; } catch {}
    await sleep(150);
  }
  return null;
}
async function waitForSearchAdvance(tabId, previousPage, previousFingerprint) { for (let attempt = 0; attempt < 40; attempt++) { try { const state = await sendSearchMessage(tabId, {type: "GET_SEARCH_PAGE_STATE"}); if (state?.ready && (Number(state.page) > Number(previousPage) || (state.page_fingerprint && state.page_fingerprint !== previousFingerprint))) return state; } catch {} await sleep(150); } return null; }
async function navigateStandardPageWithRecovery(tabId, sourceSearch, page) {
  if (page < 1) return false;
  const url = new URL(sourceSearch); url.searchParams.set("page", String(page));
  for (let attempt = 0; attempt < 5; attempt++) {
    await chrome.tabs.update(tabId, {url: url.href, active: false}); await waitLoaded(tabId);
    if (await waitForSearchPageReady(tabId, page)) return true;
    try { await chrome.tabs.reload(tabId); await waitLoaded(tabId); } catch {}
  }
  return false;
}
async function capturePageWithRecovery(tabId, page) {
  let last = {rows: [], captured: [], incomplete: [], page_fingerprint: ""};
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const result = await sendSearchMessage(tabId, {type: "CAPTURE_VISIBLE_SEARCH"}); if (result?.error_code === "linkedin_checkpoint") return result; if (!result?.blocked) { last = result; if ((result.rows || []).length) return result; } } catch {}
    try { await chrome.tabs.reload(tabId); await waitLoaded(tabId); await waitForSearchPageReady(tabId, page); } catch {}
  }
  return last;
}
async function advanceSearchPage(tabId, previousPage, previousFingerprint) {
  for (let attempt = 0; attempt < 3; attempt++) { try { const response = await sendSearchMessage(tabId, {type: "ADVANCE_SEARCH_PAGE"}); if (!response?.advanced) return null; await waitLoaded(tabId, previousFingerprint); const state = await waitForSearchAdvance(tabId, previousPage, previousFingerprint); if (state) return state; } catch {} await sleep(250); }
  return null;
}
const isSearchUrl = url => /^https:\/\/www\.linkedin\.com\/(?:search\/results\/people|sales\/search\/people)/i.test(url || "");
async function resolveCaptureTab(prior = {}, initial = false) {
  if (!initial && Number(prior.captureTabId)) { try { const tab = await chrome.tabs.get(Number(prior.captureTabId)); if (tab?.id) return tab; } catch {} }
  if (initial) return activeLinkedIn(true);
  if (!isSearchUrl(prior.sourceSearch)) throw new Error("The saved LinkedIn search is no longer available.");
  return chrome.tabs.create({url: prior.sourceSearch, active: false, windowId: Number(prior.captureWindowId) || undefined});
}
async function restoreCapturePage(tabId, sourceSearch, page) {
  const expected = new URL(sourceSearch);
  if (expected.pathname.includes("/search/results/people")) return navigateStandardPageWithRecovery(tabId, sourceSearch, page);
  const tab = await chrome.tabs.get(tabId), current = tab.url || "";
  const currentUrl = (() => { try { return new URL(current); } catch { return null; } })();
  if (!currentUrl || currentUrl.pathname !== expected.pathname) { await chrome.tabs.update(tabId, {url: expected.href, active: false}); await waitLoaded(tabId); }
  return true;
}

/* ------------------------------------------------------------- local key vault */
async function localConfig() { const c = (await chrome.storage.local.get("localConfig")).localConfig || {}; return {qwenModel: c.qwenModel || "qwen3.7-plus", region: c.region || "intl", icpText: c.icpText || ""}; }
async function vaultSessionRaw() { return (await chrome.storage.session.get("localSessionKey")).localSessionKey || ""; }
async function vaultUnlockedKey() { const raw = await vaultSessionRaw(); return raw ? importKeyRaw(raw) : null; }
async function vaultGet(kind) { const key = await vaultUnlockedKey(); if (!key) return null; const vault = (await chrome.storage.local.get("localVault")).localVault || {}; if (!vault[kind]) return ""; try { return await decryptWithKey(key, vault[kind]); } catch { return ""; } }

/* ------------------------------------------------------------- scoring context */
async function compileIcp(icpText, cfg, qwenKey) {
  const direct = extractJson(icpText);
  if (direct && (direct.criteria || direct.job_titles || direct.keywords || direct.locations)) return direct;
  const hash = await sha256Hex(icpText);
  const cached = (await chrome.storage.local.get("localIcpCompiled")).localIcpCompiled;
  if (cached && cached.hash === hash && cached.icp) return cached.icp;
  if (!qwenKey) throw new Error("Set the Qwen key to compile ICP prose, or paste a structured ICP JSON with job_titles/keywords/locations.");
  const {system, user, max_tokens, temperature, json} = compileIcpPrompt(icpText);
  const text = await chatLLM({apiKey: qwenKey, model: cfg.qwenModel, region: cfg.region, system, user, max_tokens, temperature, json});
  const parsed = extractJson(text);
  if (!parsed || !(parsed.criteria || parsed.job_titles || parsed.keywords || parsed.locations)) throw new Error("Could not compile the ICP into accepted values.");
  await chrome.storage.local.set({localIcpCompiled: {hash, icp: parsed}});
  return parsed;
}
// Best-effort Qwen expansion of accepted titles/keywords into strict variants
// (synonyms / abbreviations / FR-EN translations). Cached by content hash; a failure
// simply leaves the ICP unexpanded — the accepted values always stay authoritative.
async function expandIcpValues(icp, cfg, qwenKey) {
  if (!qwenKey || (!icp.job_titles.length && !icp.keywords.length)) return icp;
  if (icp.job_title_variants.length || icp.keyword_variants.length) return icp; // user supplied their own
  // EXPANSION_VERSION salts the cache so an improved expansion prompt regenerates
  // variants for an unchanged ICP (v2: FR masculine+feminine; v3: owner-operator
  // equivalents, short-role forms, single-token domain keywords, generalized).
  const EXPANSION_VERSION = "v3";
  const hash = await sha256Hex(`${EXPANSION_VERSION}|${JSON.stringify([icp.job_titles, icp.keywords])}`);
  const cached = (await chrome.storage.local.get("localIcpExpanded")).localIcpExpanded;
  if (cached && cached.hash === hash) return {...icp, job_title_variants: cached.job_title_variants || [], keyword_variants: cached.keyword_variants || []};
  try {
    const {system, user, max_tokens, temperature, json} = expandIcpPrompt(icp);
    const text = await chatLLM({apiKey: qwenKey, model: cfg.qwenModel, region: cfg.region, system, user, max_tokens, temperature, json});
    const parsed = extractJson(text) || {};
    const jtv = (Array.isArray(parsed.job_title_variants) ? parsed.job_title_variants : []).map(normText).filter(Boolean);
    const kwv = (Array.isArray(parsed.keyword_variants) ? parsed.keyword_variants : []).map(normText).filter(Boolean);
    await chrome.storage.local.set({localIcpExpanded: {hash, job_title_variants: jtv, keyword_variants: kwv}});
    return {...icp, job_title_variants: jtv, keyword_variants: kwv};
  } catch { return icp; }
}
async function buildScoringCtx(cfg, openaiKey, qwenKey) {
  const raw = await compileIcp(cfg.icpText, cfg, qwenKey);
  let icp = activeIcp(raw);
  if (!icp.job_titles.length && !icp.keywords.length && !icp.locations.length) throw new Error("The ICP has no accepted values (job titles, keywords, or locations).");
  icp = await expandIcpValues(icp, cfg, qwenKey);
  // Variant hygiene applied at use time (cached expansions get re-filtered too):
  // keyword variants first, then title variants (which may relate via kept keywords).
  const keptKeywordVariants = filterKeywordVariants(icp.keyword_variants || [], icp);
  icp = {...icp, keyword_variants: keptKeywordVariants};
  icp = {...icp, job_title_variants: filterTitleVariants(icp.job_title_variants || [], icp)};
  await chrome.storage.local.set({localIcpActive: {job_title_variants: icp.job_title_variants, keyword_variants: icp.keyword_variants}});
  // ICP criterion vectors persist across runs (same ICP → no re-embedding).
  const icpTexts = icpEmbedTexts(icp);
  const textsHash = await sha256Hex(JSON.stringify(icpTexts));
  const storedVecs = (await chrome.storage.local.get("localIcpVectors")).localIcpVectors;
  let icpVectors = {};
  if (storedVecs && storedVecs.hash === textsHash && storedVecs.vectors && Object.keys(storedVecs.vectors).length) {
    icpVectors = storedVecs.vectors;
    await embed(["connection test"], {apiKey: openaiKey}); // still validate the key up front
  } else {
    const vecs = icpTexts.length ? await embed(icpTexts, {apiKey: openaiKey}) : []; // also validates the OpenAI key
    icpTexts.forEach((t, i) => { if (vecs[i]) icpVectors[t] = vecs[i]; });
    await chrome.storage.local.set({localIcpVectors: {hash: textsHash, vectors: icpVectors}});
  }
  const acceptedHash = await sha256Hex(JSON.stringify(icp.locations));
  const icpHash = await sha256Hex(JSON.stringify([icp.job_titles, icp.keywords, icp.locations]));
  // Location verdicts persist across runs too.
  const locCache = (await chrome.storage.local.get("localLocCache")).localLocCache || {};
  return {cfg, icp, openaiKey, qwenKey, icpVectors, acceptedHash, icpHash, locCache, embedCache: new Map()};
}
async function resolveLocationScore(location, ctx) {
  const exact = exactLocationScore(location, ctx.icp.locations);
  if (exact !== null) return exact;
  if (!ctx.qwenKey) return 0.0;
  const key = `${ctx.acceptedHash}|${fold(location)}`;
  if (key in ctx.locCache) return ctx.locCache[key];
  let score = 0.0;
  try {
    const {system, user, max_tokens, temperature, json} = locationNormalizePrompt([location], ctx.icp.locations);
    const text = await chatLLM({apiKey: ctx.qwenKey, model: ctx.cfg.qwenModel, region: ctx.cfg.region, system, user, max_tokens, temperature, json});
    const parsed = extractJson(text) || {};
    const item = (parsed.results || []).find(r => normText(r.input) === normText(location)) || (parsed.results || [])[0];
    if (item) { const s = Number(item.score), conf = Number(item.confidence); if ([0, 0.5, 1].includes(s) && conf >= 0.75) score = s; }
  } catch {}
  ctx.locCache[key] = score;
  try { await chrome.storage.local.set({localLocCache: ctx.locCache}); } catch {}
  return score;
}
// Score one page of newly-captured rows locally. Qualification is purely score-based
// (score >= threshold → qualified). No LLM fit audit — the numeric score is the sole
// qualification signal.
async function scorePageRows(rows, ctx) {
  const fields = rows.map(r => rowFieldsFromCapture(r));
  const scorable = fields.filter(rf => rf.full_name || rf.headline || rf.job_section);
  const texts = new Set();
  for (const rf of scorable) { if (rf.job_title) texts.add(normText(rf.job_title)); const hl = normText(rf.headline); if (hl) texts.add(hl); const sh = normText(`${rf.job_section} ${rf.headline}`); if (sh) texts.add(sh); }
  const vectors = {...ctx.icpVectors};
  for (const t of texts) if (ctx.embedCache.has(t)) vectors[t] = ctx.embedCache.get(t);
  const wanted = [...texts].filter(t => !(t in vectors));
  if (wanted.length) { try { const vecs = await embed(wanted, {apiKey: ctx.openaiKey}); wanted.forEach((t, i) => { if (vecs[i]) { vectors[t] = vecs[i]; ctx.embedCache.set(t, vecs[i]); } }); } catch (e) { /* leave unmapped → NOT COMPUTED */ } }
  const out = [];
  for (const rf of fields) {
    const base = {
      full_name: rf.full_name, job_title: rf.job_title, job_section: rf.job_section, headline: rf.headline,
      company: rf.company, company_profile_url: rf.company_profile_url || "", location: rf.location, linkedin_url: rf.linkedin_url, note: "",
    };
    if (!rf.full_name && !rf.headline && !rf.job_section) {
      out.push({...base, icp_score: "NOT COMPUTED", c_job_title: null, c_job_section_headline: null, c_location: null, qualification: "unqualified", note: "private_or_empty_profile"});
      continue;
    }
    const locScore = ctx.icp.locations.length ? await resolveLocationScore(rf.location, ctx) : 0;
    const s = scoreRow(rf, ctx.icp, vectors, locScore);
    const row = {...base, icp_score: s.score, c_job_title: s.job_title, c_job_section_headline: s.job_section_headline, c_location: s.location, qualification: qualification(s.score)};
    if (s.score === "NOT COMPUTED") row.note = "embeddings_unavailable";
    else if (s.needs_review) row.note = "cross_field_title_match";
    out.push(row);
  }
  return out;
}

/* -------------------------------------------------- ICP Match phase (qualified only) */
// Compile the whole ICP document into per-ICP remaining-field structures (cached).
async function compileFullIcp(cfg, qwenKey) {
  if (!qwenKey) return null;
  const hash = await sha256Hex("fullicp-v1|" + cfg.icpText);
  const cached = (await chrome.storage.local.get("localFullIcp")).localFullIcp;
  if (cached && cached.hash === hash) return cached.icp;
  try {
    const {system, user, max_tokens, temperature, json} = compileFullIcpPrompt(cfg.icpText);
    const text = await chatLLM({apiKey: qwenKey, model: cfg.qwenModel, region: cfg.region, system, user, max_tokens, temperature, json});
    const parsed = extractJson(text);
    if (parsed && Array.isArray(parsed.icps) && parsed.icps.length) { await chrome.storage.local.set({localFullIcp: {hash, icp: parsed}}); return parsed; }
  } catch {}
  return null;
}
// Industry membership: deterministic token match first; unresolved labels get one cached
// Qwen category-membership call (like location normalization). Never invents.
async function resolveIndustryOk(pageIndustry, accepted, ctx) {
  if (!pageIndustry || !accepted.length) return null;
  if (industryTokensMatch(pageIndustry, accepted) === true) return true;
  if (!ctx.qwenKey) return false;
  const key = `${fold(pageIndustry)}|${await sha256Hex(JSON.stringify(accepted))}`;
  const cache = (await chrome.storage.local.get("localIndustryCache")).localIndustryCache || {};
  if (key in cache) return cache[key];
  let ok = false;
  try {
    const system = 'You classify whether a LinkedIn industry label belongs to any of the accepted industry categories. Judge category membership, not string equality; never invent. Output ONLY JSON {"match":true} or {"match":false}.';
    const user = JSON.stringify({industry_label: pageIndustry, accepted_industries: accepted});
    const text = await chatLLM({apiKey: ctx.qwenKey, model: ctx.cfg.qwenModel, region: ctx.cfg.region, system, user, max_tokens: 30, temperature: 0, json: true});
    ok = Boolean((extractJson(text) || {}).match);
  } catch {}
  cache[key] = ok; try { await chrome.storage.local.set({localIndustryCache: cache}); } catch {}
  return ok;
}
async function captureDeepProfile(tabId, url) {
  await chrome.tabs.update(tabId, {url, active: false, autoDiscardable: false});
  await waitLoaded(tabId);
  if (!await ensureProfileReceiver(tabId)) return {blocked: true, error_code: "receiver_unavailable"};
  try { return await chrome.tabs.sendMessage(tabId, {type: "CAPTURE_PROFILE_DEEP"}); }
  catch (e) { return {blocked: true, error_code: "deep_capture_failed", error_message: e.message}; }
}
async function captureCompanyAbout(tabId, companyUrl) {
  await chrome.tabs.update(tabId, {url: companyUrl.replace(/\/$/, "") + "/about/", active: false});
  await waitLoaded(tabId);
  if (!await ensureProfileReceiver(tabId)) return null;
  try { const c = await chrome.tabs.sendMessage(tabId, {type: "CAPTURE_COMPANY_DEEP"}); if (c?.blocked && c.error_code === "linkedin_checkpoint") return {checkpoint: true}; return (c && !c.blocked) ? c : null; } catch { return null; }
}
const compFrom = c => ({industry: normText(c.industry), company_size: normText(c.company_size)});
// Fallback signal when no company data exists: age (days) of the latest post/comment.
async function latestActivityAgeDays(tabId, profileUrl) {
  let best = null;
  for (const kind of ["posts", "comments"]) {
    try {
      await chrome.tabs.update(tabId, {url: profileUrl.replace(/\/$/, "") + `/recent-activity/${kind}/`, active: false});
      await waitLoaded(tabId); await ensureProfileReceiver(tabId);
      const items = await chrome.tabs.sendMessage(tabId, {type: "CAPTURE_ACTIVITY", activity_type: kind === "posts" ? "post" : "comment", limit: 1});
      const d = parseRelativeAgeDays(Array.isArray(items) && items[0] ? String(items[0].published_at || "") : "");
      if (d !== null && (best === null || d < best)) best = d;
    } catch {}
  }
  return best;
}
// Compute ICP Match (industry ∧ headcount) for ONE qualified prospect. Company data is
// resolved cheapest-first: company-name cache → company URL on the search card →
// (only if needed) a deep profile visit for the company link / experience-description
// URL. New company data is cached by both name and URL. Returns the fields to merge, or
// {checkpoint:true} on a LinkedIn checkpoint. Fallback when no company data exists:
// latest post/comment < 7 days → TRUE, else FALSE.
async function computeIcpMatch(row, tabId, mctx, companyCache) {
  const fullIcp = mctx.fullIcp;
  const nameKey = row.company ? "name:" + fold(row.company) : "";
  const cacheUrl = u => "url:" + fold(String(u).split(/[?#]/)[0].replace(/\/+$/, ""));
  let comp = null, source = "";
  if (nameKey && companyCache[nameKey]) { comp = companyCache[nameKey]; source = "name_cache"; }
  const tryUrl = async (url, tag) => {
    const uk = cacheUrl(url);
    if (companyCache[uk]) { comp = companyCache[uk]; source = tag + "_cache"; return "hit"; }
    const captured = await captureCompanyAbout(tabId, url);
    if (captured?.checkpoint) return "checkpoint";
    if (captured) { comp = compFrom(captured); companyCache[uk] = comp; if (nameKey) companyCache[nameKey] = comp; source = tag; return "hit"; }
    return "miss";
  };
  // 1) company URL already on the search card
  if (!comp && row.company_profile_url) { if (await tryUrl(row.company_profile_url, "card_url") === "checkpoint") return {checkpoint: true}; }
  // 2) deep profile visit only if still unresolved — grab the company link / description URL
  if (!comp) {
    const deep = await captureDeepProfile(tabId, row.linkedin_url);
    if (deep?.blocked && deep.error_code === "linkedin_checkpoint") return {checkpoint: true};
    const url2 = (!deep?.blocked && (deep.company_profile_url || deep.company_url_from_description)) || "";
    if (url2) { if (await tryUrl(url2, "deep_url") === "checkpoint") return {checkpoint: true}; }
  }
  if (comp && (comp.industry || comp.company_size)) {
    const industryOkByIcp = [];
    for (const icp of fullIcp.icps) { const inds = (icp.industries || []).map(normText).filter(Boolean); industryOkByIcp.push(inds.length ? await resolveIndustryOk(comp.industry, inds, mctx) : null); }
    const v = evaluateIcpMatch({companyIndustry: comp.industry, companyHeadcountText: comp.company_size, industryOkByIcp}, fullIcp);
    return {company_industry: comp.industry, company_headcount: comp.company_size, icp_match: v.match, matched_icp: v.matched_icp, icp_match_details: (v.details ? v.details + " · " : "") + `src:${source}`};
  }
  // 3) fallback — activity recency
  const age = await latestActivityAgeDays(tabId, row.linkedin_url);
  if (age !== null && age < 7) return {icp_match: "TRUE", matched_icp: "", icp_match_details: `company_unavailable_recent_activity(${Math.round(age * 10) / 10}d)`};
  return {icp_match: "FALSE", matched_icp: "", icp_match_details: age === null ? "company_unavailable_no_activity" : "company_unavailable_stale_activity"};
}

/* ------------------------------------------------------------- CSV finish */
// Only rows that are "ready" (unqualified, or qualified WITH ICP Match resolved) are
// ever exported — a qualified prospect is never imported before its ICP Match is done.
const readyRows = results => (results || []).filter(r => r.qualification !== "qualified" || r.icp_match);
async function finishLocal(results, stopReason) {
  const rows = dedupeRows(readyRows(results));
  let downloadOk = false, downloadError = "";
  try { const csv = buildScoreCsv(rows); await chrome.storage.local.set({localCsv: csv}); await chrome.downloads.download({url: csvDataUrl(csv), filename: "local-lead-icp-scores.csv", saveAs: false}); downloadOk = true; }
  catch (error) { downloadError = error?.message || "download_failed"; }
  const qual = rows.filter(r => r.qualification === "qualified").length, matched = rows.filter(r => r.icp_match === "TRUE").length;
  await save({running: false, stage: downloadOk ? "DONE" : "FAILED", stop_reason: stopReason,
    message: downloadOk
      ? `Done · ${rows.length} prospect(s) · ${qual} qualified · ${matched} ICP Match TRUE · CSV downloaded (${stopReason.replaceAll("_", " ")})`
      : `Run finished but CSV export failed: ${downloadError}. Use Download CSV to retry.`});
}

/* ------------------------------------------------------------- capture + score run */
const RUN_ALARM = "local-lead-url-lens-run-next";
async function scheduleDurableResume(delay = 250) { await chrome.alarms.create(RUN_ALARM, {when: Date.now() + delay}); }
async function runLocalCapture({target, resume = false} = {}) {
  const cfg = await localConfig();
  const openaiKey = await vaultGet("openai"), qwenKey = await vaultGet("qwen");
  if (openaiKey === null || qwenKey === null) { await save({running: true, paused: true, stage: "BLOCKED", message: "Key vault is locked — unlock it with your passphrase, then press Resume."}); return; }
  if (!openaiKey) { await save({running: false, stage: "FAILED", message: "Set & verify your OpenAI key (embeddings) before running."}); return; }
  const prior = resume ? await stored() : {};
  let tab; try { tab = await resolveCaptureTab(prior, !resume); } catch (e) { await save({running: false, stage: "FAILED", message: e.message}); return; }
  const captureTabId = tab.id, sourceSearch = resume && prior.sourceSearch ? prior.sourceSearch : tab.url;
  const requested = Math.min(MAX_TARGET, Math.max(1, Number(resume ? prior.target : target) || 50));
  const startPage = resume ? Math.max(1, Number(prior.page) || 1) : Math.max(1, Number(new URL(sourceSearch).searchParams.get("page")) || 1);
  if (resume && !prior.captureStop && !await restoreCapturePage(captureTabId, sourceSearch, startPage)) { await save({running: false, stage: "FAILED", message: "The LinkedIn search page could not be restored."}); return; }
  let ctx; try { ctx = await buildScoringCtx(cfg, openaiKey, qwenKey); }
  catch (e) { await save({running: false, stage: "FAILED", message: `ICP / embeddings setup failed: ${e.message}`}); return; }
  const fullIcp = await compileFullIcp(cfg, qwenKey);
  const mctx = {cfg, qwenKey, fullIcp};
  const companyCache = (await chrome.storage.local.get("localCompanyCache")).localCompanyCache || {};

  // Single in-memory source of truth shared by the two concurrent loops.
  const M = {
    rows: resume ? (prior.results || []) : [],
    seen: new Set(prior.processedProfiles || []),
    discovered: Number(prior.discovered || 0),
    pagesProcessed: Number(prior.pagesProcessed || 0),
    currentPage: startPage,
    captureDone: false,
    captureStop: (resume && prior.captureStop) || "",
  };
  const pending = () => M.rows.filter(r => r.qualification === "qualified" && !r.icp_match);
  const readyLocal = () => M.rows.filter(r => r.qualification !== "qualified" || r.icp_match);
  const counts = () => {
    const qual = M.rows.filter(r => r.qualification === "qualified");
    return {total: requested, done: readyLocal().length, discovered: M.discovered, pagesProcessed: M.pagesProcessed,
      qualifiedCount: qual.length, matchedCount: qual.filter(r => r.icp_match).length,
      matchTrueCount: M.rows.filter(r => r.icp_match === "TRUE").length, pendingCount: pending().length};
  };
  const persist = (extra = {}) => saveLocked({mode: "local", results: M.rows, processedProfiles: [...M.seen], page: M.currentPage, ...counts(), ...extra});

  await saveLocked({mode: "local", running: true, paused: false, cancelled: false, capturePaused: false, matchPaused: false,
    target: requested, sourceSearch, captureTabId, captureWindowId: tab.windowId, page: M.currentPage, results: M.rows, processedProfiles: [...M.seen],
    ...counts(), stage: M.captureStop ? "ICP_MATCH" : "SCAN_PAGE", message: resume ? "Resumed capture + ICP Match" : "Capturing, scoring and ICP-matching on this search..."});

  // ---- CAPTURE LOOP (search tab) -- never blocked by matching ----
  async function captureLoop() {
    if (M.captureStop) { M.captureDone = true; return; }
    try {
      while (M.rows.length < requested) {
        let s = await stored(); if (s.cancelled) { M.captureStop = "cancelled"; return; }
        while (s.paused || s.capturePaused) { await sleep(300); s = await stored(); if (s.cancelled) { M.captureStop = "cancelled"; return; } }
        const result = await capturePageWithRecovery(captureTabId, M.currentPage);
        if (result?.error_code === "linkedin_checkpoint") { await saveLocked({capturePaused: true, stage: "BLOCKED", message: "LinkedIn checkpoint on the search tab. Resolve it, then Resume. (ICP Match keeps running.)"}); return; }
        if (result?.blocked) { M.captureStop = result.error_code || "unsupported_search_layout"; return; }
        const fp = result.page_fingerprint || "";
        M.discovered += (result.rows || []).length; M.pagesProcessed += 1;
        const newRows = (result.captured || []).filter(row => row.profile_url && !M.seen.has(canonicalProfileUrl(row.profile_url) || row.profile_url));
        const take = newRows.slice(0, requested - M.rows.length);
        if (take.length) {
          const scored = await scorePageRows(take, ctx);
          for (const sr of scored) M.rows.push(sr);
          take.forEach(row => M.seen.add(canonicalProfileUrl(row.profile_url) || row.profile_url));
          const c = counts();
          await persist({stage: "SCAN_PAGE", message: `Page ${M.currentPage}: ${M.rows.length}/${requested} scored - ${c.qualifiedCount} qualified - ${c.pendingCount} matching`});
        }
        if (M.rows.length >= requested) { M.captureStop = "target_reached"; return; }
        if (!result.has_next) { M.captureStop = (!(result.rows || []).length && !fp) ? "capture_yielded_no_results" : "search_results_complete"; return; }
        const nextState = await advanceSearchPage(captureTabId, M.currentPage, fp); if (!nextState) { M.captureStop = "search_results_complete"; return; }
        M.currentPage = Math.max(M.currentPage + 1, Number(nextState.page) || 0);
      }
      M.captureStop = "target_reached";
    } catch (e) { M.captureStop = M.captureStop || `capture_error:${String(e && e.message || "error").slice(0, 60)}`; }
    finally { M.captureDone = true; await persist({captureStop: M.captureStop}); }
  }

  // ---- MATCH CONSUMER (worker tab) -- commits a qualified row only once matched ----
  async function matchConsumer() {
    if (!fullIcp) return; // no full-ICP compile (needs Qwen) -> handled at finish
    let worker = null;
    try {
      while (true) {
        let s = await stored(); if (s.cancelled) return;
        while (s.paused || s.matchPaused) { await sleep(400); s = await stored(); if (s.cancelled) return; }
        const item = pending()[0];
        if (!item) { if (M.captureDone) return; await sleep(300); continue; }
        if (!worker) worker = await acquireLinkedInWorkerTab(item.linkedin_url || "https://www.linkedin.com/feed/");
        const c = counts();
        await persist({stage: "ICP_MATCH", message: `ICP Match ${c.matchedCount + 1}/${c.qualifiedCount} (${c.matchTrueCount} TRUE - ${c.pendingCount} pending) - ${item.full_name || item.linkedin_url}`});
        let res;
        try { res = await computeIcpMatch(item, worker.tab.id, mctx, companyCache); }
        catch (e) { if (String(e && e.message) === "cancelled") return; res = {icp_match: "FALSE", matched_icp: "", icp_match_details: `icp_match_error:${String(e && e.message || "error").slice(0, 60)}`}; }
        if (res.checkpoint) { await saveLocked({matchPaused: true, stage: "BLOCKED", message: "LinkedIn checkpoint in the worker tab (ICP Match). Resolve it, then Resume. (Capture keeps running.)"}); continue; }
        Object.assign(item, res);
        if (!item.icp_match) item.icp_match = "FALSE"; // never leave an attempted row unresolved
        try { await chrome.storage.local.set({localCompanyCache: companyCache}); } catch {}
        await persist();
      }
    } catch (e) { /* leave remaining pending for a durable resume */ }
  }

  await Promise.all([captureLoop(), matchConsumer()]);

  const st = await stored();
  if (st.cancelled) { await closeWorkerTab(); await save({running: false, stage: "CANCELLED", message: `Cancelled - ${readyLocal().length} row(s) ready. Use Download CSV for partial results.`}); return; }
  if (st.paused || st.capturePaused || st.matchPaused) return; // checkpoint/pause -> Resume re-enters and continues
  if (!fullIcp && pending().length) { await finishLocalPassthrough(M.rows, M.captureStop || "batch_complete"); return; }
  if (pending().length) return; // safety: a checkpoint left rows pending; heartbeat resumes
  await closeWorkerTab();
  await finishLocal(M.rows, M.captureStop || "batch_complete");
}
// No Qwen key -> no full-ICP compile: export qualified rows with ICP Match PENDING
// rather than blocking them forever.
async function finishLocalPassthrough(results, stopReason) {
  const rows = results.map(r => (r.qualification === "qualified" && !r.icp_match) ? {...r, icp_match: "PENDING", icp_match_details: "icp_match_not_evaluated_no_qwen_key"} : r);
  await finishLocal(rows, stopReason);
}
async function resumeDurableOperation() { const state = await stored(); if (!state.running || state.paused || wakeLock) return; wakeLock = true; try { if (state.mode === "local") await runLocalCapture({resume: true}); } finally { wakeLock = false; } }

/* ------------------------------------------------------------- messages */
chrome.runtime.onMessage.addListener((message, _sender, send) => { (async () => {
  if (message.type === "GET_STATUS") {
    const meta = (await chrome.storage.local.get("localKeyMeta")).localKeyMeta || {};
    const vault = (await chrome.storage.local.get("localVault")).localVault || {};
    const cfg = await localConfig();
    const active = (await chrome.storage.local.get("localIcpActive")).localIcpActive || null;
    return {ok: true, meta, hasPassphrase: Boolean(vault.kdf && vault.verifier), unlocked: Boolean(await vaultSessionRaw()), cfg: {qwenModel: cfg.qwenModel, region: cfg.region},
      variants: active ? {titles: (active.job_title_variants || []).length, keywords: (active.keyword_variants || []).length} : null};
  }
  if (message.type === "SET_PASSPHRASE") {
    const pass = String(message.passphrase || ""); if (pass.length < 6) return {ok: false, error: "Passphrase must be at least 6 characters."};
    const vault = (await chrome.storage.local.get("localVault")).localVault || {};
    if (vault.kdf) return {ok: false, error: "A passphrase already exists. Unlock, then use Change."};
    const {key, saltB64} = await deriveVaultKey(pass);
    await chrome.storage.local.set({localVault: {kdf: {salt: saltB64, iterations: KDF_ITERATIONS}, verifier: await makeVerifier(key)}});
    await chrome.storage.session.set({localSessionKey: await exportKeyRaw(key)});
    return {ok: true};
  }
  if (message.type === "UNLOCK_VAULT") {
    const pass = String(message.passphrase || ""); if (!pass) return {ok: false, error: "Enter your passphrase."};
    const vault = (await chrome.storage.local.get("localVault")).localVault || {};
    if (!vault.kdf || !vault.verifier) return {ok: false, error: "No passphrase set yet.", needsSetup: true};
    const {key} = await deriveVaultKey(pass, vault.kdf.salt);
    if (!await checkVerifier(key, vault.verifier)) return {ok: false, error: "Incorrect passphrase."};
    await chrome.storage.session.set({localSessionKey: await exportKeyRaw(key)});
    return {ok: true};
  }
  if (message.type === "CHANGE_PASSPHRASE") {
    const pass = String(message.passphrase || ""); if (pass.length < 6) return {ok: false, error: "New passphrase must be at least 6 characters."};
    const oldKey = await vaultUnlockedKey(); if (!oldKey) return {ok: false, error: "Unlock with the current passphrase first."};
    const vault = (await chrome.storage.local.get("localVault")).localVault || {};
    const {key, saltB64} = await deriveVaultKey(pass);
    const next = {kdf: {salt: saltB64, iterations: KDF_ITERATIONS}, verifier: await makeVerifier(key)};
    for (const kind of ["openai", "qwen"]) { if (vault[kind]) { try { next[kind] = await encryptWithKey(key, await decryptWithKey(oldKey, vault[kind])); } catch {} } }
    await chrome.storage.local.set({localVault: next});
    await chrome.storage.session.set({localSessionKey: await exportKeyRaw(key)});
    return {ok: true};
  }
  if (message.type === "LOCK_VAULT") { await chrome.storage.session.remove("localSessionKey"); return {ok: true}; }
  if (message.type === "SET_KEY") {
    const kind = message.kind; if (!["openai", "qwen"].includes(kind)) return {ok: false, error: "Unknown key."};
    const value = String(message.value || "").trim(); if (!value) return {ok: false, error: "Enter a key value."};
    const sessKey = await vaultUnlockedKey(); if (!sessKey) return {ok: false, error: "Unlock the vault with your passphrase first."};
    const vault = (await chrome.storage.local.get("localVault")).localVault || {};
    vault[kind] = await encryptWithKey(sessKey, value);
    const cfg = (await chrome.storage.local.get("localConfig")).localConfig || {};
    if (kind === "qwen") { if (message.region) cfg.region = message.region; cfg.qwenModel = String(message.model || cfg.qwenModel || "qwen3.7-plus").trim(); }
    await chrome.storage.local.set({localVault: vault, localConfig: cfg});
    let verified = false, error = "";
    try {
      if (kind === "qwen") { await chatLLM({apiKey: value, model: cfg.qwenModel, region: cfg.region || "intl", system: "You are a connection test.", user: "Reply with OK.", max_tokens: 5}); verified = true; }
      else { const v = await embed(["connection test"], {apiKey: value}); verified = Array.isArray(v) && Array.isArray(v[0]) && v[0].length > 0; if (!verified) error = "OpenAI returned no embedding vector."; }
    } catch (e) { error = e.message; }
    const meta = (await chrome.storage.local.get("localKeyMeta")).localKeyMeta || {};
    meta[kind] = {set: true, verified}; await chrome.storage.local.set({localKeyMeta: meta});
    return {ok: true, verified, error};
  }
  if (message.type === "CLEAR_KEY") { const kind = message.kind; const v = (await chrome.storage.local.get("localVault")).localVault || {}; const m = (await chrome.storage.local.get("localKeyMeta")).localKeyMeta || {}; delete v[kind]; delete m[kind]; await chrome.storage.local.set({localVault: v, localKeyMeta: m}); return {ok: true}; }
  if (message.type === "START_LOCAL") {
    const state = await stored(); if (wakeLock || state.running) return {ok: false, error: "A run is already active."};
    const meta = (await chrome.storage.local.get("localKeyMeta")).localKeyMeta || {};
    if (!meta.openai?.set) return {ok: false, error: "Set & verify your OpenAI key (embeddings) first."};
    if (!(await vaultSessionRaw())) return {ok: false, error: "Unlock the key vault with your passphrase first."};
    if (!String(message.icpText || "").trim()) return {ok: false, error: "Provide an ICP (paste text, a file, or a URL) first."};
    try { await activeLinkedIn(true); } catch (e) { return {ok: false, error: e.message}; }
    const cfg = (await chrome.storage.local.get("localConfig")).localConfig || {};
    await chrome.storage.local.set({localConfig: {...cfg, qwenModel: String(message.qwenModel || cfg.qwenModel || "qwen3.7-plus").trim(), region: message.region || cfg.region || "intl", icpText: String(message.icpText || "")}});
    await chrome.storage.local.remove("localCsv");
    await save({mode: "local", running: false, paused: false, cancelled: false, capturePaused: false, matchPaused: false, results: [], processedProfiles: [], discovered: 0, pagesProcessed: 0, done: 0, qualifiedCount: 0, matchedCount: 0, matchTrueCount: 0, pendingCount: 0, captureStop: "", workerTabId: 0, target: Math.max(1, Number(message.target) || 50), stage: "QUEUED", message: "Starting local capture + scoring…"});
    wakeLock = true; runLocalCapture({target: message.target}).finally(() => wakeLock = false);
    return {ok: true};
  }
  if (message.type === "PAUSE_OPERATION") { await saveLocked({paused: true, message: "Paused at a safe point"}); return {ok: true}; }
  if (message.type === "RESUME_OPERATION") { await saveLocked({paused: false, capturePaused: false, matchPaused: false, running: true, cancelled: false, message: "Resuming…"}); await resumeDurableOperation(); return {ok: true}; }
  if (message.type === "CANCEL_OPERATION") { await saveLocked({cancelled: true, running: false, paused: false, capturePaused: false, matchPaused: false, stage: "CANCELLED", message: "Cancelled. Use Download CSV for partial results."}); await closeWorkerTab(); return {ok: true}; }
  if (message.type === "DOWNLOAD_CSV") {
    const state = await stored(); const results = readyRows(state.results || []);
    if (results.length) { const csv = buildScoreCsv(dedupeRows(results)); await chrome.storage.local.set({localCsv: csv}); await chrome.downloads.download({url: csvDataUrl(csv), filename: "local-lead-icp-scores.csv"}); return {ok: true}; }
    const {localCsv} = await chrome.storage.local.get("localCsv");
    if (localCsv) { await chrome.downloads.download({url: csvDataUrl(localCsv), filename: "local-lead-icp-scores.csv"}); return {ok: true}; }
    return {ok: false, error: "No results to export yet."};
  }
  if (message.type === "OPEN_URL") { await chrome.tabs.create({url: message.url}); return {ok: true}; }
  return {ok: true, wakeLock};
})().then(send).catch(async error => { await save({running: false, stage: "FAILED", message: error.message}); send({ok: false, error: error.message}); }); return true; });

chrome.alarms.create("local-lead-url-lens-heartbeat", {periodInMinutes: 0.5});
chrome.alarms.onAlarm.addListener(async alarm => { if (!["local-lead-url-lens-heartbeat", RUN_ALARM].includes(alarm.name)) return; const state = await stored(); if (state.running) { await save({heartbeat_at: new Date().toISOString()}); await resumeDurableOperation(); } });
chrome.action.onClicked.addListener(async tab => { if (!tab.id || !/^https:\/\/www\.linkedin\.com\//.test(tab.url || "")) return; try { await chrome.tabs.sendMessage(tab.id, {type: "TOGGLE_PANEL"}); } catch { await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ["panel.js"]}); await sleep(100); await chrome.tabs.sendMessage(tab.id, {type: "TOGGLE_PANEL"}); } });
async function updateAction(tabId, url = "") { if (/^https:\/\/www\.linkedin\.com\//.test(url)) await chrome.action.enable(tabId); else await chrome.action.disable(tabId); }
chrome.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.url || change.status === "complete") updateAction(tabId, change.url || tab.url || ""); });
chrome.tabs.onActivated.addListener(async info => { const tab = await chrome.tabs.get(info.tabId); updateAction(info.tabId, tab.url || ""); });
