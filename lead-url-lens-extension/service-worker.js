/* TechNFirms Lead URL Lens — user initiated, durable, inactive-tab, checkpoint safe. */
import {parseProfileLinks, canonicalProfileUrl, rowFieldsFromCapture, normText, fold, activeCriteria, normalizedWeights, icpEmbedTexts, scoreProfile, exactLocationScore, compileIcpPrompt, locationNormalizePrompt, buildScoreCsv, csvDataUrl, chatLLM, embed, extractJson, sha256Hex, deriveVaultKey, exportKeyRaw, importKeyRaw, encryptWithKey, decryptWithKey, makeVerifier, checkVerifier, KDF_ITERATIONS} from "./feed.js";
const feedEmbedCache = new Map();
const MAX_TARGET = 500;
const FEED_MAX = 1000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let wakeLock = false;

async function config() { return chrome.storage.local.get(["crm", "token"]); }
async function timedFetch(url,request,timeoutMs=30000){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);try{return await fetch(url,{...request,signal:controller.signal})}catch(error){if(error?.name==="AbortError")throw new Error("CRM synchronization is still processing. Progress remains saved; resume safely if the result does not appear.");throw error}finally{clearTimeout(timer)}}
async function api(path, options = {}) {
  const {crm, token} = await config();
  if (!crm || !token) throw new Error("Connect and verify the CRM first");
  const request = {...options, credentials: "include", headers: {"content-type": "application/json", authorization: `Bearer ${token}`, ...options.headers}};
  const timeoutMs=path.startsWith("/api/enrich")?120000:30000;
  let response = await timedFetch(crm + path, request, timeoutMs), data;
  try { data = await response.json(); } catch { data = {error: `CRM error ${response.status}`}; }
  if (!response.ok) { const error=new Error(data.error || `CRM error ${response.status}`); error.code=data.code||([401,403].includes(response.status)?"PAIRING_TOKEN_INVALID":"CRM_REQUEST_FAILED"); error.status=response.status; throw error; }
  return data;
}
async function stored() { return (await chrome.storage.local.get("operationState")).operationState || {mode: "idle"}; }
async function save(patch) { const current = await stored(), next = {...current, ...patch, updated_at: new Date().toISOString()}; await chrome.storage.local.set({operationState: next}); return next; }
async function activeLinkedIn(searchOnly = false) {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true}), url = tab?.url || "";
  const accepted = searchOnly ? /^https:\/\/www\.linkedin\.com\/(?:search\/results\/people|sales\/search\/people)/.test(url) : /^https:\/\/www\.linkedin\.com\//.test(url);
  if (!tab?.id || !accepted) throw new Error(searchOnly ? "Open a LinkedIn People Search or Sales Navigator search first" : "Open an authenticated LinkedIn tab first");
  return tab;
}
async function acquireLinkedInWorkerTab(preferredUrl="https://www.linkedin.com/feed/"){
  const state=await stored();
  if(Number(state.workerTabId)){try{const tab=await chrome.tabs.get(Number(state.workerTabId));if(tab?.id&&/^https:\/\/www\.linkedin\.com\//.test(tab.url||preferredUrl)){try{await chrome.tabs.update(tab.id,{autoDiscardable:false})}catch{}return{tab,owned:true}}}catch{}}
  const tab=await chrome.tabs.create({url:preferredUrl,active:false});
  try{await chrome.tabs.update(tab.id,{autoDiscardable:false})}catch{}
  await save({workerTabId:tab.id});
  return{tab,owned:true};
}
async function waitLoaded(tabId, previousFingerprint = "") {
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await stored(); if (state.cancelled) throw new Error("cancelled");
    while ((await stored()).paused) await sleep(350);
    const tab = await chrome.tabs.get(tabId); if (tab.status === "complete") break; await sleep(250);
  }
  await sleep(previousFingerprint ? 260 : 180);
}
async function ensureProfileReceiver(tabId){
  for(let attempt=0;attempt<20;attempt++){
    try{const response=await chrome.tabs.sendMessage(tabId,{type:"PROFILE_RECEIVER_PING"});if(response?.ready)return true}catch{}
    if(attempt===2)try{await chrome.scripting.executeScript({target:{tabId},files:["experience-contract.js","content.js"]})}catch{}
    await sleep(250);
  }
  return false;
}
async function captureProfileSurface(tabId,profileUrl){
  let last={blocked:true,error_code:"profile_surface_timeout",error_message:"LinkedIn profile header did not finish rendering."};
  const [previousActive]=await chrome.tabs.query({active:true,currentWindow:true});
  for(let attempt=0;attempt<3;attempt++){
    await chrome.tabs.update(tabId,{url:profileUrl,active:attempt>=1,autoDiscardable:false});
    await waitLoaded(tabId);
    if(!await ensureProfileReceiver(tabId)){last={blocked:true,error_code:"profile_receiver_unavailable",error_message:"The LinkedIn profile content receiver did not start."};continue}
    try{last=await chrome.tabs.sendMessage(tabId,{type:"CAPTURE_PROFILE"})}catch(error){last={blocked:true,error_code:"profile_capture_failed",error_message:error.message}}
    if(!last?.blocked||!["profile_surface_timeout","profile_receiver_unavailable","profile_capture_failed"].includes(last.error_code))break;
    if(attempt<2)try{await chrome.tabs.reload(tabId);await waitLoaded(tabId)}catch{}
  }
  if(previousActive?.id&&previousActive.id!==tabId)try{await chrome.tabs.update(previousActive.id,{active:true})}catch{}
  return last;
}
async function sendSearchMessage(tabId, message) {
  let ready = false;
  try {
    const response = await chrome.tabs.sendMessage(tabId, {type: "SEARCH_RECEIVER_PING"});
    ready = response?.ready === true;
  } catch {}
  if (!ready) {
    await chrome.scripting.executeScript({target: {tabId}, files: ["search-content.js"]});
    await sleep(150);
  }
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw new Error(`LinkedIn page receiver could not start. Reload the LinkedIn tab once, then retry. ${error.message}`);
  }
}
async function runEvent(runId, event, data = {}) { if (!runId) return; try { await api("/api/extension/runs", {method: "POST", body: JSON.stringify({action: "event", run_id: runId, event, data})}); } catch {} }
async function startRun(kind, data) { const result = await api("/api/extension/runs", {method: "POST", body: JSON.stringify({action: "start", kind, ...data})}); return result.run_id; }
async function finishRun(runId, status, stopReason, metrics) { if (!runId) return; try { await api("/api/extension/runs", {method: "POST", body: JSON.stringify({action: "finish", run_id: runId, status, stop_reason: stopReason, metrics})}); } catch {} }

async function waitForSearchPageReady(tabId,expectedPage=0) {
  for(let attempt=0;attempt<24;attempt++){
    const state = await stored(); if (state.cancelled) throw new Error("cancelled");
    while((await stored()).paused)await sleep(250);
    try{const pageState=await sendSearchMessage(tabId,{type:"GET_SEARCH_PAGE_STATE"});if(pageState?.ready&&(!expectedPage||Number(pageState.page)===expectedPage))return pageState}catch{}
    await sleep(150);
  }
  return null;
}
async function waitForSearchAdvance(tabId,previousPage,previousFingerprint){for(let attempt=0;attempt<40;attempt++){try{const state=await sendSearchMessage(tabId,{type:"GET_SEARCH_PAGE_STATE"});if(state?.ready&&(Number(state.page)>Number(previousPage)||(state.page_fingerprint&&state.page_fingerprint!==previousFingerprint)))return state}catch{}await sleep(150)}return null}
async function navigateStandardPageWithRecovery(tabId,sourceSearch,page){
  if(page<1)return false;
  const url=new URL(sourceSearch);url.searchParams.set("page",String(page));
  for(let attempt=0;attempt<5;attempt++){
    await chrome.tabs.update(tabId,{url:url.href,active:false});await waitLoaded(tabId);
    if(await waitForSearchPageReady(tabId,page))return true;
    try{await chrome.tabs.reload(tabId);await waitLoaded(tabId)}catch{}
  }
  return false;
}
async function capturePageWithRecovery(tabId,page){
  let last={rows:[],captured:[],incomplete:[],page_fingerprint:""};
  for(let attempt=0;attempt<3;attempt++){
    try{const result=await sendSearchMessage(tabId,{type:"CAPTURE_VISIBLE_SEARCH"});if(result?.error_code==="linkedin_checkpoint")return result;if(!result?.blocked){last=result;if((result.rows||[]).length)return result}}catch{}
    try{await chrome.tabs.reload(tabId);await waitLoaded(tabId);await waitForSearchPageReady(tabId,page)}catch{}
  }
  return last;
}
async function advanceSearchPage(tabId,previousPage,previousFingerprint){
  for(let attempt=0;attempt<3;attempt++){try{const response=await sendSearchMessage(tabId,{type:"ADVANCE_SEARCH_PAGE"});if(!response?.advanced)return null;await waitLoaded(tabId,previousFingerprint);const state=await waitForSearchAdvance(tabId,previousPage,previousFingerprint);if(state)return state}catch{}await sleep(250)}
  return null;
}
const isSearchUrl=url=>/^https:\/\/www\.linkedin\.com\/(?:search\/results\/people|sales\/search\/people)/i.test(url||"");
async function resolveCaptureTab(prior={},initial=false){
  if(!initial&&Number(prior.captureTabId)){try{const tab=await chrome.tabs.get(Number(prior.captureTabId));if(tab?.id)return tab}catch{}}
  if(initial)return activeLinkedIn(true);
  if(!isSearchUrl(prior.sourceSearch))throw new Error("The saved LinkedIn search is no longer available.");
  return chrome.tabs.create({url:prior.sourceSearch,active:false,windowId:Number(prior.captureWindowId)||undefined});
}
async function restoreCapturePage(tabId,sourceSearch,page){
  const expected=new URL(sourceSearch);
  if(expected.pathname.includes("/search/results/people"))return navigateStandardPageWithRecovery(tabId,sourceSearch,page);
  const tab=await chrome.tabs.get(tabId),current=tab.url||"";
  const currentUrl=(()=>{try{return new URL(current)}catch{return null}})();
  if(!currentUrl||currentUrl.pathname!==expected.pathname){
    await chrome.tabs.update(tabId,{url:expected.href,active:false});await waitLoaded(tabId);
  }
  return true;
}
async function captureSearch({target, listName, importId=0, resume = false}) {
  const prior=resume?await stored():{},tab=await resolveCaptureTab(prior,!resume),tabId=tab.id,sourceSearch=resume&&prior.sourceSearch?prior.sourceSearch:tab.url,requested=Math.min(MAX_TARGET,Math.max(1,Number(target)||50));
  if(!String(listName||"").trim())throw new Error("Import list name is required.");
  const sourceUrl=new URL(sourceSearch),page=resume?Math.max(1,Number(prior.page)||1):Math.max(1,Number(sourceUrl.searchParams.get("page"))||1);if(resume&&!await restoreCapturePage(tabId,sourceSearch,page))throw new Error("page_load_failed");
  const capture_run_id = resume && prior.capture_run_id ? prior.capture_run_id : await startRun("capture", {source_search: sourceSearch, list_name: listName, import_id:Number(importId)||0,target: requested});
  let currentPage=page,imported=Number(prior.imported||0),discovered=Number(prior.discovered||0),existing=Number(prior.existing||0),incomplete=Number(prior.incomplete||0),pagesProcessed=Number(prior.pagesProcessed||0),pageFailures=Number(prior.pageFailures||0),stopReason="search_results_complete";
  const seenProfiles=new Set(prior.processedProfiles||[]),seenFingerprints=new Set(prior.processedFingerprints||[]);let currentImportId=Number(resume?prior.importId:importId)||0;
  await save({mode:"capture",running:true,paused:false,cancelled:false,capture_run_id,target:requested,listName,importId:currentImportId,sourceSearch,page:currentPage,captureTabId:tabId,captureWindowId:tab.windowId,processedProfiles:[...seenProfiles],processedFingerprints:[...seenFingerprints],imported,discovered,existing,incomplete,pagesProcessed,pageFailures,message:resume?"Resumed from the last durable checkpoint":"Capturing pages until the requested new-contact target is reached",stage:"SCAN_PAGE"});
  try {
    while (imported < requested) {
      const state = await stored(); if (state.cancelled) { stopReason = "cancelled"; break; }
      while ((await stored()).paused) await sleep(250);
      const result=await capturePageWithRecovery(tabId,currentPage);
      if(result?.error_code==="linkedin_checkpoint"){stopReason="linkedin_checkpoint";throw new Error(stopReason)}
      if(result?.blocked){stopReason=result.error_code||"unsupported_search_layout";throw new Error(stopReason)}
      const page_fingerprint = result.page_fingerprint || "";
      if(page_fingerprint&&seenFingerprints.has(page_fingerprint)){
        await runEvent(capture_run_id, "page_repeat_advance", {page:currentPage, page_fingerprint});
      }
      discovered+=(result.rows||[]).length;incomplete+=(result.incomplete||[]).length;pagesProcessed+=1;
      const candidates=(result.captured||[]).filter(row=>row.profile_url&&!seenProfiles.has(row.profile_url));
      const remaining=requested-imported;let rows=candidates;
      if(candidates.length){const preflight=await api("/api/extension/preflight",{method:"POST",body:JSON.stringify({profile_urls:candidates.map(row=>row.profile_url)})}),existingUrls=new Set(preflight.existing_profile_urls||[]);existing+=existingUrls.size;rows=candidates.filter(row=>!existingUrls.has(row.profile_url))}
      if (rows.length&&remaining>0) {
        await save({stage:"IMPORT_PAGE",message:`Importing every new profile from page ${currentPage}…`});
        const idempotency_key=`${capture_run_id}:${currentPage}:${page_fingerprint.slice(0,80)}`;
        const response=await api("/api/extension/import",{method:"POST",body:JSON.stringify({list_name:listName,import_id:currentImportId||undefined,source_search:sourceSearch,rows,max_new:remaining,capture_all:true,capture_run_id,page_fingerprint,idempotency_key})});currentImportId=Number(response.import_id)||currentImportId;
        imported += Number(response.chunk?.created || 0); existing += Number(response.chunk?.duplicates || 0);
      }
      candidates.forEach(row=>seenProfiles.add(row.profile_url));
      if(page_fingerprint)seenFingerprints.add(page_fingerprint);
      await runEvent(capture_run_id,"page_acknowledged",{page:currentPage,page_fingerprint,discovered:(result.rows||[]).length,captured:rows.length,incomplete:(result.incomplete||[]).length,imported,existing_crm:existing,page_failures:pageFailures});
      await save({stage:"page_acknowledged",page:currentPage,importId:currentImportId,processedProfiles:[...seenProfiles],processedFingerprints:[...seenFingerprints],imported,discovered,existing,incomplete,pagesProcessed,pageFailures,message:`Page ${currentPage}: ${imported}/${requested} new contacts imported`});
      if (imported >= requested) { stopReason = "target_reached"; break; }
      if(!result.has_next){stopReason="search_results_complete";break}
      await save({stage:"NEXT_PAGE"});
      const nextState=await advanceSearchPage(tabId,currentPage,page_fingerprint);if(!nextState){stopReason="search_results_complete";break}
      currentPage=Math.max(currentPage+1,Number(nextState.page)||0);await save({page:currentPage,stage:"SCAN_PAGE"});
    }
    await finishRun(capture_run_id,stopReason==="cancelled"?"cancelled":"completed",stopReason,{pages:pagesProcessed,discovered,accepted:discovered-incomplete,imported,existing,ambiguous:incomplete});
    await save({running:false,stage:"DONE",stop_reason:stopReason,message:`${imported}/${requested} new contacts imported · ${stopReason.replaceAll("_"," ")}`});
  } catch (error) {
    const blocked = ["linkedin_checkpoint", "unsupported_search_layout"].includes(error.message);
    await finishRun(capture_run_id,blocked?"blocked":"failed",stopReason||error.message,{pages:pagesProcessed,discovered,accepted:discovered-incomplete,imported,existing,ambiguous:incomplete});
    await save({running: false, stage: blocked ? "BLOCKED" : "FAILED", stop_reason: stopReason || error.message, message: blocked ? `Stopped safely: ${error.message}` : error.message});
  }
}

async function postProfileEvent(job, status, data = {}, extra = {}) { return api("/api/extension/sync", {method: "POST", body: JSON.stringify({events: [{event_id: crypto.randomUUID(), lead_id: job.lead_id, stage: job.stage, status, data, ...extra}]})}); }
function codedError(code, detail = "") { const error = new Error(detail ? `${code}: ${detail}` : code); error.code = code; return error; }
async function resolveFromSearch(tabId, job) {
  if (!/^https:\/\/www\.linkedin\.com\/search\/results\/people\//i.test(job.source_search || "")) return "";
  for (let page = 1; page <= 100; page++) { const url = new URL(job.source_search); url.searchParams.set("page", String(page)); await chrome.tabs.update(tabId, {url: url.href, active: false}); await waitLoaded(tabId); const result = await chrome.tabs.sendMessage(tabId, {type: "RESOLVE_FROM_SEARCH", full_name: job.full_name, company: job.company}); if (result?.error_code === "linkedin_checkpoint") throw codedError("linkedin_checkpoint"); if (result?.profile_url) return result.profile_url; if(result?.has_next===false)break; }
  return "";
}
async function captureProfile(tabId, job) {
  let profileUrl = job.profile_url;
  let data = await captureProfileSurface(tabId,profileUrl);
  if (data?.blocked && ["unsupported_page", "unsupported_layout", "profile_capture_failed","profile_receiver_unavailable"].includes(data.error_code)) { const resolved = await resolveFromSearch(tabId, job); if (resolved) { profileUrl = resolved;data=await captureProfileSurface(tabId,resolved); } }
  if (data?.blocked || !data?.validation?.completed) { const code = data?.error_code || "profile_validation_failed", detail = data?.error_message || data?.validation?.errors?.join(", ") || "Required visible profile facts were not captured"; const status=["linkedin_checkpoint","authentication_required"].includes(code)?"blocked_user_action":"retryable_failed"; await postProfileEvent(job, status, data || {}, {error_code: code, error_message: detail}); throw codedError(code, detail); }
  data.source_search = job.source_search || data.source_search;
  await postProfileEvent(job, "completed", data);
  await chrome.tabs.update(tabId, {url: profileUrl.replace(/\/$/, "") + "/recent-activity/posts/", active: false}); await waitLoaded(tabId);await ensureProfileReceiver(tabId);
  let posts=[];try{posts=await chrome.tabs.sendMessage(tabId,{type:"CAPTURE_ACTIVITY",activity_type:"post",limit:7})}catch{}
  if(posts?.blocked)throw codedError(posts.error_code||"posts_capture_failed",posts.error_message||"");
  posts=Array.isArray(posts)?posts.slice(0,7):[];
  const commentTarget=posts.length>=7?5:Math.max(5,Math.min(12,12-posts.length));
  await chrome.tabs.update(tabId,{url:profileUrl.replace(/\/$/,"")+"/recent-activity/comments/",active:false});await waitLoaded(tabId);await ensureProfileReceiver(tabId);
  let comments=[];try{comments=await chrome.tabs.sendMessage(tabId,{type:"CAPTURE_ACTIVITY",activity_type:"comment",limit:commentTarget})}catch{}
  if(comments?.blocked)throw codedError(comments.error_code||"comments_capture_failed",comments.error_message||"");
  comments=Array.isArray(comments)?comments.slice(0,commentTarget):[];
  const activity=[...posts,...comments].filter((item,index,items)=>items.findIndex(other=>(other.activity_url||other.url||other.source_id)===(item.activity_url||item.url||item.source_id))===index).slice(0,12);
  data.posts=posts;data.comments=comments;data.activity_items=activity;data.activity_target=12;data.activity_captured=activity.length;data.posts_analyzed=posts.length;data.comments_analyzed=comments.length;data.activity_coverage_status=activity.length>=12?"complete":"partial_accessible";
  await postProfileEvent({...job,stage:"activity"},"completed",data);
  if(data.company_profile_url){
    const companyUrl=data.company_profile_url.replace(/\/$/,"")+"/about/";
    try{
      await chrome.tabs.update(tabId,{url:companyUrl,active:false});await waitLoaded(tabId);await ensureProfileReceiver(tabId);
      const companyPage=await chrome.tabs.sendMessage(tabId,{type:"CAPTURE_COMPANY"});
      if(companyPage?.blocked&&companyPage.error_code==="linkedin_checkpoint")throw codedError("linkedin_checkpoint");
      if(companyPage&&!companyPage.blocked){data.company_page=companyPage;data.company_website_candidate=companyPage.website||"";data.company_logo_url=data.company_logo_url||companyPage.company_logo_url||"";data.evidence=[...(data.evidence||[]),...(companyPage.evidence||[])]}
    }catch(error){if(error?.code==="linkedin_checkpoint")throw error;data.company_capture_error=error?.message||"company_capture_failed"}
  }
  if(data.company_page)await postProfileEvent({...job,stage:"company"},"completed",data);
  const warnings=[];
  try { await api("/api/enrich", {method: "POST", body: JSON.stringify({lead_id: job.lead_id, action: "resolve_domain",domain:data.company_website_candidate||undefined})}); } catch(error){warnings.push(`website: ${error.message}`)}
  try { await api("/api/enrich", {method: "POST", body: JSON.stringify({lead_id: job.lead_id, action: "generate_persona"})}); } catch(error){throw codedError("persona_generation_failed",error.message)}
  return warnings;
}
async function heartbeatLease(job){return api("/api/extension/queue",{method:"POST",body:JSON.stringify({action:"heartbeat",job_id:job.id,lease_id:job.lease_id})})}
async function releaseLease(job,runId){if(!job?.id&&!runId)return;try{await api("/api/extension/queue",{method:"POST",body:JSON.stringify({action:"release",job_id:job?.id,lease_id:job?.lease_id,run_id:runId})})}catch{}}
async function withLeaseHeartbeat(job,operation){
  await heartbeatLease(job);
  const timer=setInterval(()=>void heartbeatLease(job).catch(()=>{}),60_000);
  try{return await operation()}finally{clearInterval(timer)}
}
const RUN_ALARM="lead-url-lens-run-next";
async function scheduleDurableResume(delay=250){await chrome.alarms.create(RUN_ALARM,{when:Date.now()+delay})}
async function closeWorkerTab(){const state=await stored(),id=Number(state.workerTabId||0);if(id)try{await chrome.tabs.remove(id)}catch{}await save({workerTabId:0})}
async function beginEnrichment({importId,limit}){
  const requested=Math.min(MAX_TARGET,Math.max(1,Number(limit)||100)),runId=await startRun("enrichment",{import_id:Number(importId),target:requested});
  await save({mode:"enrichment",running:true,paused:false,cancelled:false,run_id:runId,importId:Number(importId),target:requested,requestedTarget:requested,total:requested,done:0,failed:0,attempted:0,currentJob:null,currentLeaseId:"",workerTabId:0,message:"Enrichment queued. The durable executor will continue across tab changes.",stage:"QUEUED"});
  await scheduleDurableResume();
}
async function enrichQueue({importId, limit, resume = false, maxSteps = Infinity}) {
  const prior=resume?await stored():{},requested=Math.min(MAX_TARGET,Math.max(1,Number(limit)||100)),runId=resume&&prior.run_id?prior.run_id:await startRun("enrichment",{import_id:Number(importId),target:requested});
  let done=Number(prior.done||0),failed=Number(prior.failed||0),attempted=Number(prior.attempted||done+failed),stopReason="batch_complete",currentJob=resume&&prior.currentJob?prior.currentJob:null,worker=null,consecutiveContractFailures=Number(prior.consecutiveContractFailures||0),steps=0;
  await save({mode:"enrichment",running:true,paused:Boolean(prior.paused),cancelled:Boolean(prior.cancelled),run_id:runId,importId:Number(importId),target:requested,requestedTarget:requested,total:requested,done,failed,attempted,currentJob,currentLeaseId:currentJob?.lease_id||"",message:resume?"Durable enrichment step resumed":"Ready to claim the next contact",stage:"PROCESSING"});
  try{
    while(attempted<requested&&steps<maxSteps){
      let state=await stored();if(state.cancelled){stopReason="cancelled";break}while(state.paused){await sleep(350);state=await stored();if(state.cancelled){stopReason="cancelled";break}}if(state.cancelled)break;
      if(currentJob){try{await heartbeatLease(currentJob)}catch{currentJob=null;await save({currentJob:null,currentLeaseId:""})}}
      if(!currentJob){const response=await api("/api/extension/queue",{method:"POST",body:JSON.stringify({action:"claim",import_id:Number(importId),limit:1,run_id:runId})});currentJob=(response.jobs||[])[0]||null}
      if(!currentJob){stopReason="queue_empty";break}
      if(!worker)worker=await acquireLinkedInWorkerTab(currentJob.profile_url||"https://www.linkedin.com/feed/");
      await save({currentJob,currentLeaseId:currentJob.lease_id,message:`Enriching ${currentJob.full_name||"profile"} · ${attempted+1}/${requested}`});
      try{
        const warnings=await withLeaseHeartbeat(currentJob,()=>captureProfile(worker.tab.id,currentJob));done+=1;consecutiveContractFailures=0;await runEvent(runId,"profile_completed",{lead_id:currentJob.lead_id,warnings});
      }catch(error){
        const code=error?.code||String(error?.message||"capture_failed").split(":")[0];
        failed+=1;
        if(!["profile_validation_failed","profile_surface_timeout","experience_section_not_found","linkedin_checkpoint","authentication_required"].includes(code))await postProfileEvent(currentJob,"retryable_failed",{},{error_code:code,error_message:error.message});
        if(["profile_validation_failed","profile_surface_timeout","experience_section_not_found"].includes(code))consecutiveContractFailures+=1;else consecutiveContractFailures=0;
        await runEvent(runId,"profile_failed",{lead_id:currentJob.lead_id,error_code:code,error_message:error.message});
        if(consecutiveContractFailures>=3)await runEvent(runId,"layout_warning",{message:"Three profiles failed the Experience contract; each remains individually retryable."});
        if(["linkedin_checkpoint","authentication_required"].includes(code)){stopReason=code;attempted+=1;await save({done,failed,attempted,currentJob:null,currentLeaseId:""});currentJob=null;break}
      }
      attempted+=1;currentJob=null;await save({done,failed,attempted,currentJob:null,currentLeaseId:""});
      steps+=1;
    }
  }finally{
    if(currentJob)await releaseLease(currentJob,runId);
  }
  if(attempted<requested&&!["queue_empty","cancelled","linkedin_checkpoint","authentication_required"].includes(stopReason)){
    await save({running:true,done,failed,attempted,currentJob:null,currentLeaseId:"",consecutiveContractFailures,stage:"WAITING_NEXT_PROFILE",message:`${done} enriched · ${failed} failed · continuing in the background`});
    await scheduleDurableResume();
    return;
  }
  const blocked=["linkedin_checkpoint","authentication_required"].includes(stopReason),cancelled=stopReason==="cancelled";
  await finishRun(runId,blocked?"blocked":cancelled?"cancelled":"completed",stopReason,{done,failed});
  await closeWorkerTab();
  await save({running:false,stage:blocked?"BLOCKED":"DONE",done,failed,attempted,currentJob:null,currentLeaseId:"",stop_reason:stopReason,message:blocked?`Stopped safely: ${stopReason}. Blocked contacts remain retryable.`:`${done} profile(s) enriched · ${failed} failed · ${stopReason.replaceAll("_"," ")}`});
}

/* ----------------------------------------------------------------- Feed workflow */
async function feedConfig(){const c=(await chrome.storage.local.get("feedConfig")).feedConfig||{};return {qwenModel:c.qwenModel||"qwen3.7-plus", region:c.region||"intl", icpText:c.icpText||""};}
// Passphrase vault: the derived AES key lives only in chrome.storage.session (memory,
// cleared when the browser closes), so it survives SW restarts but locks each session.
async function vaultSessionRaw(){return (await chrome.storage.session.get("feedSessionKey")).feedSessionKey||"";}
async function vaultUnlockedKey(){const raw=await vaultSessionRaw();return raw?importKeyRaw(raw):null;}
async function vaultGet(kind){const key=await vaultUnlockedKey();if(!key)return null;const vault=(await chrome.storage.local.get("feedVault")).feedVault||{};if(!vault[kind])return "";try{return await decryptWithKey(key,vault[kind]);}catch{return "";}}
// Feed capture: uses the graceful CAPTURE_PROFILE_LITE (top-card facts + best-effort
// experience, no hard-fail on a missing Experience section). Attempt 1 runs in the
// background tab; retries briefly activate the tab so LinkedIn's lazy-loaded
// Experience list renders (hidden tabs often never populate it), then focus is restored.
async function captureProfileLiteSurface(tabId, profileUrl){
  let last={blocked:true,error_code:"profile_surface_timeout",error_message:"Profile did not render."};
  const [prev]=await chrome.tabs.query({active:true,currentWindow:true});
  for(let attempt=0;attempt<3;attempt++){
    await chrome.tabs.update(tabId,{url:profileUrl,active:attempt>=1,autoDiscardable:false});
    await waitLoaded(tabId);
    if(!await ensureProfileReceiver(tabId)){last={blocked:true,error_code:"profile_receiver_unavailable"};continue;}
    try{last=await chrome.tabs.sendMessage(tabId,{type:"CAPTURE_PROFILE_LITE"});}catch(error){last={blocked:true,error_code:"profile_capture_failed",error_message:error.message};}
    if(last&&!last.blocked)break;
    if(["linkedin_checkpoint","authentication_required","unsupported_page","profile_name_missing"].includes(last?.error_code))break;
    try{await chrome.tabs.reload(tabId);await waitLoaded(tabId);}catch{}
  }
  if(prev?.id&&prev.id!==tabId)try{await chrome.tabs.update(prev.id,{active:true});}catch{}
  return last;
}
// Compile the user's ICP (prose/JSON) into the scoring schema. Structured JSON is
// used directly; prose is compiled by one cached Qwen call (keyed on the ICP hash).
async function compileIcp(icpText, cfg, qwenKey){
  const direct = extractJson(icpText);
  if(direct && (direct.icp?.criteria || direct.criteria)) return direct.icp ? direct : {icp:direct};
  const hash = await sha256Hex(icpText);
  const cached = (await chrome.storage.local.get("feedIcpCompiled")).feedIcpCompiled;
  if(cached && cached.hash===hash && cached.icp?.icp?.criteria) return cached.icp;
  if(!qwenKey) throw new Error("Set the Qwen key to compile the ICP prose, or paste a structured ICP JSON.");
  const {system,user,max_tokens,temperature,json}=compileIcpPrompt(icpText);
  const text=await chatLLM({provider:"qwen",apiKey:qwenKey,model:cfg.qwenModel,region:cfg.region,system,user,max_tokens,temperature,json});
  const parsed=extractJson(text);
  const icp = parsed?.icp?.criteria ? parsed : (parsed?.criteria ? {icp:parsed} : null);
  if(!icp || !icp.icp?.criteria) throw new Error("Could not compile the ICP into the scoring schema.");
  await chrome.storage.local.set({feedIcpCompiled:{hash,icp}});
  return icp;
}
// Location score: deterministic exact/containment first; unresolved → one cached Qwen call.
async function resolveLocationScore(location, ctx){
  const exact = exactLocationScore(location, ctx.acceptedLocations);
  if(exact!==null) return exact;
  if(!ctx.qwenKey) return 0.0;
  const cacheKey=`${ctx.acceptedHash}|${fold(location)}`;
  const cache=(await chrome.storage.local.get("feedLocCache")).feedLocCache||{};
  if(cacheKey in cache) return cache[cacheKey];
  let score=0.0;
  try{
    const {system,user,max_tokens,temperature,json}=locationNormalizePrompt([location], ctx.acceptedLocations);
    const text=await chatLLM({provider:"qwen",apiKey:ctx.qwenKey,model:ctx.cfg.qwenModel,region:ctx.cfg.region,system,user,max_tokens,temperature,json});
    const parsed=extractJson(text)||{};
    const item=(parsed.results||[]).find(r=>normText(r.input)===normText(location))||(parsed.results||[])[0];
    if(item){const s=Number(item.score),conf=Number(item.confidence);if([0,0.5,1].includes(s)&&conf>=0.75)score=s;}
  }catch{}
  cache[cacheKey]=score; await chrome.storage.local.set({feedLocCache:cache});
  return score;
}
// Score one LinkedIn result: capture → extract fields → embed (OpenAI) → deterministic score.
async function scoreOneProfile(url, ctx){
  const worker = await acquireLinkedInWorkerTab(url);
  const data = await captureProfileLiteSurface(worker.tab.id, url);
  if(data?.blocked && data.error_code==="linkedin_checkpoint") return {checkpoint:true};
  const rf = rowFieldsFromCapture(data?.blocked ? {profile_url:url} : data);
  const row = {full_name:rf.full_name, job_section:rf.job_section, headline:rf.headline, location:rf.location, linkedin_url:rf.linkedin_url||url, icp_score:"NOT COMPUTED"};
  if(data?.blocked){row._note=data.error_code||"capture_failed"; return {row};}
  const payload = normText(`${rf.job_section} ${rf.headline}`) || "[missing profile text]";
  const vectors = {...ctx.icpVectors};
  try{
    if(!ctx.embedCache.has(payload)){const [v]=await embed([payload],{apiKey:ctx.openaiKey}); if(v)ctx.embedCache.set(payload,v);}
    if(ctx.embedCache.has(payload)) vectors[payload]=ctx.embedCache.get(payload);
  }catch(e){row._note=`embed_error: ${e.message}`; return {row};}
  const locScore = ctx.active.locations ? await resolveLocationScore(rf.location, ctx) : 0;
  row.icp_score = scoreProfile(rf, ctx.active, ctx.weights, vectors, locScore);
  return {row};
}
async function finishFeed(state, stopReason){
  const results = state.feedResults || [];
  let downloadOk=false, downloadError="";
  try{const csv=buildScoreCsv(results);await chrome.storage.local.set({feedCsv:csv});await chrome.downloads.download({url:csvDataUrl(csv), filename:"icp-scores.csv", saveAs:false});downloadOk=true;}
  catch(error){downloadError=error?.message||"download_failed";}
  await closeWorkerTab();
  const scored = results.filter(r=>Number.isFinite(Number(r.icp_score))).length, notComputed = results.length-scored;
  await save({running:false, stage:downloadOk?"DONE":"FAILED", stop_reason:stopReason,
    message: downloadOk ? `Feed complete · ${results.length} rows · ${scored} scored · ${notComputed} not computed · CSV downloaded`
      : `Feed finished but CSV export failed: ${downloadError}. Use Download CSV to retry.`});
}
async function runFeed({resume=false}={}){
  const cfg = await feedConfig();
  const qwenKey = await vaultGet("qwen");
  const openaiKey = await vaultGet("embeddings");
  const state = await stored();
  let results = resume ? (state.feedResults||[]) : [];
  let index = resume ? Number(state.feedIndex||0) : 0;
  const urls = state.feedUrls || [];
  if(!Array.isArray(urls) || !urls.length){await save({running:false, stage:"FAILED", message:"No LinkedIn profile URLs were found in the file."}); return;}
  if(qwenKey===null || openaiKey===null){await save({running:true, paused:true, stage:"BLOCKED", message:"Key vault is locked — unlock it with your passphrase, then press Resume."}); return;}
  if(!openaiKey){await save({running:false, stage:"FAILED", message:"Set & verify the OpenAI key (embeddings) before running Feed."}); return;}
  await save({mode:"feed", running:true, paused:false, cancelled:false, feedUrls:urls, feedIndex:index, feedResults:results,
    total:urls.length, done:results.length, stage:"COMPILING", message: resume?"Resuming ICP scoring…":"Compiling the ICP and embedding its criteria…"});
  let active, weights, icpVectors, acceptedLocations, acceptedHash;
  try{
    const icp = await compileIcp(cfg.icpText, cfg, qwenKey);
    active = activeCriteria(icp.icp);
    weights = normalizedWeights(active);
    if(!weights) throw new Error("The compiled ICP has no weighted criteria.");
    const texts = icpEmbedTexts(active);
    const vecs = texts.length ? await embed(texts, {apiKey:openaiKey}) : [];
    icpVectors = {}; texts.forEach((t,i)=>{if(vecs[i])icpVectors[t]=vecs[i];});
    acceptedLocations = (active.locations?.values||[]).map(normText);
    acceptedHash = await sha256Hex(JSON.stringify(acceptedLocations));
  }catch(e){await save({running:false, stage:"FAILED", message:`ICP setup failed: ${e.message}`}); return;}
  const ctx = {cfg, qwenKey, openaiKey, active, weights, icpVectors, acceptedLocations, acceptedHash, embedCache:feedEmbedCache};
  let stopReason="batch_complete";
  try{
    while(index < urls.length){
      let s=await stored(); if(s.cancelled){stopReason="cancelled";break;}
      while(s.paused){await sleep(400);s=await stored();if(s.cancelled)break;} if(s.cancelled){stopReason="cancelled";break;}
      const url = urls[index];
      await save({stage:"SCORE", message:`Scoring ${index+1}/${urls.length}: ${url}`});
      let outcome;
      try{outcome = await scoreOneProfile(url, ctx);}
      catch(error){outcome = {row:{full_name:"", job_section:"", headline:"", location:"", linkedin_url:url, icp_score:"NOT COMPUTED", _note:error?.message||"error"}};}
      if(outcome.checkpoint){await save({paused:true, stage:"BLOCKED", message:"LinkedIn security checkpoint detected. Resolve it in the worker tab, then press Resume."}); return;}
      results = [...results, outcome.row]; index += 1;
      await save({feedResults:results, feedIndex:index, done:results.length, message:`Scored ${index}/${urls.length}`});
    }
  }catch(error){await save({running:false, stage:"FAILED", message:`Feed failed: ${error?.message||error}`}); return;}
  if(stopReason==="cancelled"){await closeWorkerTab();await save({running:false, stage:"CANCELLED", message:`Cancelled · ${results.length} scored. Use Download CSV for partial results.`}); return;}
  await finishFeed(await stored(), stopReason);
}
async function resumeDurableOperation(){const state=await stored();if(!state.running||state.paused||wakeLock)return;wakeLock=true;try{if(state.mode==="capture")await captureSearch({target:state.target,listName:state.listName,importId:state.importId,resume:true});else if(state.mode==="enrichment")await enrichQueue({importId:state.importId,limit:state.target,resume:true,maxSteps:1});else if(state.mode==="feed")await runFeed({resume:true})}finally{wakeLock=false}}

chrome.runtime.onMessage.addListener((message, _sender, send) => { (async () => {
  if (message.type === "CONNECT_TEST") return api("/api/extension/queue?limit=1");
  if (message.type === "LOAD_LISTS") return api("/api/extension/queue?limit=1");
  if (message.type === "START_CAPTURE") {if(!String(message.listName||"").trim())throw new Error("Import list name is required."); const state = await stored(); if (!state.running) { wakeLock = true; captureSearch({target: message.target, listName: message.listName,importId:message.importId}).finally(() => wakeLock = false); } return {ok: true}; }
  if (message.type === "START_QUEUE") { const state = await stored(); if (!state.running) await beginEnrichment({importId: message.importId, limit: message.limit}); return {ok: true}; }
  if (message.type === "PAUSE_OPERATION") { await save({paused: true, message: "Paused at a safe point"}); return {ok: true}; }
  if (message.type === "RESUME_OPERATION") { await save({paused: false, message: "Resuming from the last durable checkpoint…"});await resumeDurableOperation();return {ok: true}; }
  if (message.type === "CANCEL_OPERATION") { const state=await save({cancelled:true,running:false,paused:false,stage:"CANCELLED",message:"Cancelled. Any active contact is returning to the queue."});if(state.mode==="enrichment"){await releaseLease(state.currentJob,state.run_id);await closeWorkerTab();await finishRun(state.run_id,"cancelled","cancelled",{done:Number(state.done||0),failed:Number(state.failed||0)})}else if(state.mode==="feed"){await closeWorkerTab()}return {ok: true}; }
  if(message.type==="OPEN_CRM"){await chrome.tabs.create({url:message.url});return{ok:true}}
  if(message.type==="GET_FEED_KEY_STATUS"){
    const meta=(await chrome.storage.local.get("feedKeyMeta")).feedKeyMeta||{};
    const vault=(await chrome.storage.local.get("feedVault")).feedVault||{};
    const cfg=await feedConfig();
    return{ok:true,meta,hasPassphrase:Boolean(vault.kdf&&vault.verifier),unlocked:Boolean(await vaultSessionRaw()),cfg:{qwenModel:cfg.qwenModel,region:cfg.region}};
  }
  if(message.type==="SET_PASSPHRASE"){
    const pass=String(message.passphrase||""); if(pass.length<6)return{ok:false,error:"Passphrase must be at least 6 characters."};
    const vault=(await chrome.storage.local.get("feedVault")).feedVault||{};
    if(vault.kdf)return{ok:false,error:"A passphrase already exists. Unlock, then use Change passphrase."};
    const {key,saltB64}=await deriveVaultKey(pass);
    await chrome.storage.local.set({feedVault:{kdf:{salt:saltB64,iterations:KDF_ITERATIONS},verifier:await makeVerifier(key)}});
    await chrome.storage.session.set({feedSessionKey:await exportKeyRaw(key)});
    return{ok:true};
  }
  if(message.type==="UNLOCK_VAULT"){
    const pass=String(message.passphrase||""); if(!pass)return{ok:false,error:"Enter your passphrase."};
    const vault=(await chrome.storage.local.get("feedVault")).feedVault||{};
    if(!vault.kdf||!vault.verifier)return{ok:false,error:"No passphrase set yet.",needsSetup:true};
    const {key}=await deriveVaultKey(pass,vault.kdf.salt);
    if(!await checkVerifier(key,vault.verifier))return{ok:false,error:"Incorrect passphrase."};
    await chrome.storage.session.set({feedSessionKey:await exportKeyRaw(key)});
    return{ok:true};
  }
  if(message.type==="CHANGE_PASSPHRASE"){
    const pass=String(message.passphrase||""); if(pass.length<6)return{ok:false,error:"New passphrase must be at least 6 characters."};
    const oldKey=await vaultUnlockedKey(); if(!oldKey)return{ok:false,error:"Unlock with the current passphrase first."};
    const vault=(await chrome.storage.local.get("feedVault")).feedVault||{};
    const {key,saltB64}=await deriveVaultKey(pass);
    const next={kdf:{salt:saltB64,iterations:KDF_ITERATIONS},verifier:await makeVerifier(key)};
    for(const kind of ["qwen","embeddings"]){if(vault[kind]){try{next[kind]=await encryptWithKey(key,await decryptWithKey(oldKey,vault[kind]));}catch{}}}
    await chrome.storage.local.set({feedVault:next});
    await chrome.storage.session.set({feedSessionKey:await exportKeyRaw(key)});
    return{ok:true};
  }
  if(message.type==="LOCK_VAULT"){await chrome.storage.session.remove("feedSessionKey");return{ok:true};}
  if(message.type==="SET_FEED_KEY"){
    const kind=message.kind; if(!["qwen","embeddings"].includes(kind))return{ok:false,error:"Unknown key."};
    const value=String(message.value||"").trim(); if(!value)return{ok:false,error:"Enter a key value."};
    const sessKey=await vaultUnlockedKey(); if(!sessKey)return{ok:false,error:"Unlock the vault with your passphrase first."};
    const vault=(await chrome.storage.local.get("feedVault")).feedVault||{};
    vault[kind]=await encryptWithKey(sessKey,value);
    const cfg=(await chrome.storage.local.get("feedConfig")).feedConfig||{};
    if(kind==="qwen"){if(message.region)cfg.region=message.region;cfg.qwenModel=String(message.model||cfg.qwenModel||"qwen3.7-plus").trim();}
    await chrome.storage.local.set({feedVault:vault,feedConfig:cfg});
    const region=cfg.region||"intl";
    let verified=false,error="";
    try{
      if(kind==="qwen"){await chatLLM({provider:"qwen",apiKey:value,model:cfg.qwenModel,region,system:"You are a connection test.",user:"Reply with OK.",max_tokens:5});verified=true;}
      else{const v=await embed(["connection test"],{apiKey:value});verified=Array.isArray(v)&&Array.isArray(v[0])&&v[0].length>0;if(!verified)error="OpenAI returned no embedding vector.";}
    }catch(e){error=e.message;}
    const meta=(await chrome.storage.local.get("feedKeyMeta")).feedKeyMeta||{};
    meta[kind]={set:true,verified}; await chrome.storage.local.set({feedKeyMeta:meta});
    return{ok:true,verified,error};
  }
  if(message.type==="CLEAR_FEED_KEY"){const kind=message.kind;const v=(await chrome.storage.local.get("feedVault")).feedVault||{};const m=(await chrome.storage.local.get("feedKeyMeta")).feedKeyMeta||{};delete v[kind];delete m[kind];await chrome.storage.local.set({feedVault:v,feedKeyMeta:m});return{ok:true};}
  if(message.type==="START_FEED"){
    const state=await stored(); if(state.running)return{ok:false,error:"An operation is already running."};
    const urls=parseProfileLinks(message.linksText||"");
    if(!urls.length)return{ok:false,error:"No LinkedIn profile URLs found in the file or link."};
    const meta=(await chrome.storage.local.get("feedKeyMeta")).feedKeyMeta||{};
    if(!meta.embeddings?.set)return{ok:false,error:"Set the OpenAI API key (embeddings) first."};
    if(!(await vaultSessionRaw()))return{ok:false,error:"Unlock the key vault with your passphrase first."};
    if(!String(message.icpText||"").trim())return{ok:false,error:"Provide an ICP (icps.md file or URL) first."};
    const cfg=(await chrome.storage.local.get("feedConfig")).feedConfig||{};
    await chrome.storage.local.set({feedConfig:{...cfg,qwenModel:String(message.qwenModel||cfg.qwenModel||"qwen3.7-plus").trim(),region:message.region||cfg.region||"intl",icpText:String(message.icpText||"")}});
    await chrome.storage.local.remove("feedCsv");
    feedEmbedCache.clear();
    await save({mode:"feed",feedUrls:urls.slice(0,FEED_MAX),feedIndex:0,feedResults:[],total:urls.length,done:0,running:false,paused:false,cancelled:false,stage:"QUEUED",message:`Queued ${urls.length} profile(s) for ICP scoring`});
    wakeLock=true; runFeed({}).finally(()=>wakeLock=false);
    return{ok:true,count:urls.length};
  }
  if(message.type==="DOWNLOAD_FEED_CSV"){
    const state=await stored(); const results=state.feedResults||[];
    if(results.length){const csv=buildScoreCsv(results);await chrome.storage.local.set({feedCsv:csv});await chrome.downloads.download({url:csvDataUrl(csv),filename:"icp-scores.csv"});return{ok:true};}
    const {feedCsv}=await chrome.storage.local.get("feedCsv");
    if(feedCsv){await chrome.downloads.download({url:csvDataUrl(feedCsv),filename:"icp-scores.csv"});return{ok:true};}
    return{ok:false,error:"No Feed results to export yet."};
  }
  return {ok: true, wakeLock};
})().then(send).catch(async error => { await save({running: false, stage: "FAILED", message: error.message}); send({ok: false, error: error.message}); }); return true; });

chrome.alarms.create("lead-url-lens-heartbeat", {periodInMinutes: 0.5});
chrome.alarms.onAlarm.addListener(async alarm => { if (!["lead-url-lens-heartbeat",RUN_ALARM].includes(alarm.name)) return; const state = await stored(); if (state.running){await save({heartbeat_at: new Date().toISOString()});await resumeDurableOperation()} });
chrome.action.onClicked.addListener(async tab=>{if(!tab.id||!/^https:\/\/www\.linkedin\.com\//.test(tab.url||""))return;try{await chrome.tabs.sendMessage(tab.id,{type:"TOGGLE_PANEL"})}catch{await chrome.scripting.executeScript({target:{tabId:tab.id},files:["panel.js"]});await sleep(100);await chrome.tabs.sendMessage(tab.id,{type:"TOGGLE_PANEL"})}});
async function updateAction(tabId,url=""){if(/^https:\/\/www\.linkedin\.com\//.test(url))await chrome.action.enable(tabId);else await chrome.action.disable(tabId)}chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{if(change.url||change.status==="complete")updateAction(tabId,change.url||tab.url||"")});chrome.tabs.onActivated.addListener(async info=>{const tab=await chrome.tabs.get(info.tabId);updateAction(info.tabId,tab.url||"")});
