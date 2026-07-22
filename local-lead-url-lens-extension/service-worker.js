/* Local Lead URL Lens — capture LinkedIn People Search prospects (same capture rules
 * as the CRM extension) and score them locally against your ICP with the fixed
 * Job Title 65 / Job Section·Headline 20 / Location 15 contract, then export a CSV.
 * No backend / CRM: OpenAI (embeddings) + optional Qwen keys live in a local
 * passphrase-gated vault; all scoring math is deterministic in code. */
import {
  canonicalProfileUrl, rowFieldsFromCapture, normText, fold, activeIcp, icpEmbedTexts,
  scoreRow, exactLocationScore, compileIcpPrompt, locationNormalizePrompt, expandIcpPrompt,
  qualification, buildScoreCsv, dedupeRows, filterTitleVariants, filterKeywordVariants, csvDataUrl, chatLLM, embed, extractJson, sha256Hex,
  deriveVaultKey, exportKeyRaw, importKeyRaw, encryptWithKey, decryptWithKey, makeVerifier,
  checkVerifier, KDF_ITERATIONS,
} from "./feed.js";

const MAX_TARGET = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let wakeLock = false;

/* ------------------------------------------------------------- durable state */
async function stored() { return (await chrome.storage.local.get("operationState")).operationState || {mode: "idle"}; }
async function save(patch) { const current = await stored(), next = {...current, ...patch, updated_at: new Date().toISOString()}; await chrome.storage.local.set({operationState: next}); return next; }

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
      company: rf.company, location: rf.location, linkedin_url: rf.linkedin_url, note: "",
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

/* ------------------------------------------------------------- CSV finish */
async function finishLocal(results, stopReason) {
  const rows = dedupeRows(results);
  let downloadOk = false, downloadError = "";
  try { const csv = buildScoreCsv(rows); await chrome.storage.local.set({localCsv: csv}); await chrome.downloads.download({url: csvDataUrl(csv), filename: "local-lead-icp-scores.csv", saveAs: false}); downloadOk = true; }
  catch (error) { downloadError = error?.message || "download_failed"; }
  const scored = rows.filter(r => Number.isFinite(Number(r.icp_score))).length, notComputed = rows.length - scored;
  await save({running: false, stage: downloadOk ? "DONE" : "FAILED", stop_reason: stopReason,
    message: downloadOk
      ? `Done · ${rows.length} prospect(s) · ${scored} scored · ${notComputed} not computed · CSV downloaded (${stopReason.replaceAll("_", " ")})`
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
  const tabId = tab.id, sourceSearch = resume && prior.sourceSearch ? prior.sourceSearch : tab.url;
  const requested = Math.min(MAX_TARGET, Math.max(1, Number(resume ? prior.target : target) || 50));
  const sourceUrl = new URL(sourceSearch), page = resume ? Math.max(1, Number(prior.page) || 1) : Math.max(1, Number(sourceUrl.searchParams.get("page")) || 1);
  if (resume && !await restoreCapturePage(tabId, sourceSearch, page)) { await save({running: false, stage: "FAILED", message: "The LinkedIn search page could not be restored."}); return; }

  let ctx; try { ctx = await buildScoringCtx(cfg, openaiKey, qwenKey); }
  catch (e) { await save({running: false, stage: "FAILED", message: `ICP / embeddings setup failed: ${e.message}`}); return; }

  const seen = new Set(prior.processedProfiles || []);
  let results = resume ? (prior.results || []) : [];
  let collected = results.length, discovered = Number(prior.discovered || 0), pagesProcessed = Number(prior.pagesProcessed || 0), currentPage = page, stopReason = "search_results_complete";
  await save({mode: "local", running: true, paused: false, cancelled: false, target: requested, sourceSearch, captureTabId: tabId, captureWindowId: tab.windowId, page: currentPage, processedProfiles: [...seen], results, total: requested, done: collected, discovered, pagesProcessed, stage: "SCAN_PAGE", message: resume ? "Resumed local capture + scoring" : "Capturing and scoring prospects on this search…"});
  try {
    while (collected < requested) {
      const state = await stored(); if (state.cancelled) { stopReason = "cancelled"; break; }
      while ((await stored()).paused) await sleep(250);
      const result = await capturePageWithRecovery(tabId, currentPage);
      if (result?.error_code === "linkedin_checkpoint") { await save({running: true, paused: true, stage: "BLOCKED", message: "LinkedIn security checkpoint detected. Resolve it in the tab, then press Resume."}); return; }
      if (result?.blocked) { stopReason = result.error_code || "unsupported_search_layout"; throw new Error(stopReason); }
      const page_fingerprint = result.page_fingerprint || "";
      discovered += (result.rows || []).length; pagesProcessed += 1;
      const newRows = (result.captured || []).filter(row => row.profile_url && !seen.has(canonicalProfileUrl(row.profile_url) || row.profile_url));
      const take = newRows.slice(0, requested - collected);
      if (take.length) {
        await save({stage: "SCORE", message: `Scoring ${take.length} new prospect(s) from page ${currentPage}…`});
        const scored = await scorePageRows(take, ctx);
        results = [...results, ...scored]; collected += scored.length;
        take.forEach(row => seen.add(canonicalProfileUrl(row.profile_url) || row.profile_url));
      }
      const sc = results.filter(r => Number.isFinite(Number(r.icp_score))).length;
      await save({page: currentPage, processedProfiles: [...seen], results, done: collected, discovered, pagesProcessed, scored: sc, notComputed: results.length - sc, message: `Page ${currentPage}: ${collected}/${requested} prospect(s) captured + scored`});
      if (collected >= requested) { stopReason = "target_reached"; break; }
      if (!result.has_next) { stopReason = (!(result.rows || []).length && !page_fingerprint) ? "capture_yielded_no_results" : "search_results_complete"; break; }
      await save({stage: "NEXT_PAGE"});
      const nextState = await advanceSearchPage(tabId, currentPage, page_fingerprint); if (!nextState) { stopReason = "search_results_complete"; break; }
      currentPage = Math.max(currentPage + 1, Number(nextState.page) || 0); await save({page: currentPage, stage: "SCAN_PAGE"});
    }
    if (stopReason === "cancelled") { await save({running: false, stage: "CANCELLED", message: `Cancelled · ${results.length} scored. Use Download CSV for partial results.`}); return; }
    await finishLocal(results, stopReason);
  } catch (error) {
    await save({running: false, stage: "FAILED", stop_reason: stopReason || error.message, message: error.message});
  }
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
    await save({mode: "local", running: false, paused: false, cancelled: false, results: [], processedProfiles: [], discovered: 0, pagesProcessed: 0, done: 0, target: Math.max(1, Number(message.target) || 50), stage: "QUEUED", message: "Starting local capture + scoring…"});
    wakeLock = true; runLocalCapture({target: message.target}).finally(() => wakeLock = false);
    return {ok: true};
  }
  if (message.type === "PAUSE_OPERATION") { await save({paused: true, message: "Paused at a safe point"}); return {ok: true}; }
  if (message.type === "RESUME_OPERATION") { await save({paused: false, running: true, cancelled: false, message: "Resuming…"}); await resumeDurableOperation(); return {ok: true}; }
  if (message.type === "CANCEL_OPERATION") { await save({cancelled: true, running: false, paused: false, stage: "CANCELLED", message: "Cancelled. Use Download CSV for partial results."}); return {ok: true}; }
  if (message.type === "DOWNLOAD_CSV") {
    const state = await stored(); const results = state.results || [];
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
