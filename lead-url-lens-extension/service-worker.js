/* TechNFirms Lead URL Lens — user initiated, durable, inactive-tab, checkpoint safe. */
import {parseProfileLinks, factsForProfile, profileEmbeddingText, computeIcp, verdictBand, buildIcpReport, personaOutreachPrompt, chatLLM, embed, extractJson, buildFeedCsv, csvDataUrl, deriveVaultKey, exportKeyRaw, importKeyRaw, encryptWithKey, decryptWithKey, makeVerifier, checkVerifier, KDF_ITERATIONS, ICP1_VECTOR_TEXT, ICP2_VECTOR_TEXT} from "./feed.js";
const feedHeadcountCache = new Map();
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
async function feedConfig(){const c=(await chrome.storage.local.get("feedConfig")).feedConfig||{};return {chatProvider:c.chatProvider||"qwen",chatModel:c.chatModel||"",embedProvider:c.embedProvider||"qwen",embedModel:c.embedModel||"",region:c.region||"intl",threshold:Number.isFinite(Number(c.threshold))?Number(c.threshold):60,icpText:c.icpText||"",offerText:c.offerText||""};}
// Passphrase vault: the derived AES key lives only in chrome.storage.session (memory,
// cleared when the browser closes), so it survives SW restarts but locks each session.
async function vaultSessionRaw(){return (await chrome.storage.session.get("feedSessionKey")).feedSessionKey||"";}
async function vaultUnlockedKey(){const raw=await vaultSessionRaw();return raw?importKeyRaw(raw):null;}
async function vaultGet(kind){const key=await vaultUnlockedKey();if(!key)return null;const vault=(await chrome.storage.local.get("feedVault")).feedVault||{};if(!vault[kind])return "";try{return await decryptWithKey(key,vault[kind]);}catch{return "";}}
function feedString(value){return typeof value==="string"?value:(value==null?"":JSON.stringify(value));}
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
async function captureProfileForFeed(tabId, profileUrl){
  const data = await captureProfileLiteSurface(tabId, profileUrl);
  if(data?.blocked && data.error_code==="linkedin_checkpoint") return {checkpoint:true};
  if(data?.blocked){
    return {ok:false, error_code:data?.error_code||"profile_capture_failed", error_message:data?.error_message||""};
  }
  // Best-effort recent activity + company facts — strengthens outreach, never blocks the row.
  try{await chrome.tabs.update(tabId,{url:profileUrl.replace(/\/$/,"")+"/recent-activity/posts/",active:false});await waitLoaded(tabId);await ensureProfileReceiver(tabId);const posts=await chrome.tabs.sendMessage(tabId,{type:"CAPTURE_ACTIVITY",activity_type:"post",limit:5}).catch(()=>[]);data.posts=Array.isArray(posts)?posts.slice(0,5):[];}catch{data.posts=[];}
  try{await chrome.tabs.update(tabId,{url:profileUrl.replace(/\/$/,"")+"/recent-activity/comments/",active:false});await waitLoaded(tabId);await ensureProfileReceiver(tabId);const comments=await chrome.tabs.sendMessage(tabId,{type:"CAPTURE_ACTIVITY",activity_type:"comment",limit:7}).catch(()=>[]);data.comments=Array.isArray(comments)?comments.slice(0,7):[];}catch{data.comments=[];}
  if(data.company_profile_url){try{await chrome.tabs.update(tabId,{url:data.company_profile_url.replace(/\/$/,"")+"/about/",active:false});await waitLoaded(tabId);await ensureProfileReceiver(tabId);const company=await chrome.tabs.sendMessage(tabId,{type:"CAPTURE_COMPANY"}).catch(()=>null);if(company&&!company.blocked)data.company_page=company;}catch{}}
  return {ok:true, data};
}
async function analyzeFeedProfile(url, ctx){
  const worker = await acquireLinkedInWorkerTab(url);
  const captured = await captureProfileForFeed(worker.tab.id, url);
  if(captured.checkpoint) return {checkpoint:true};
  const row = {url, icp_score:"", icp_total:null, persona_card:"", opportunity_score:"", outreach_1:"", outreach_2:"", outreach_3:"", raw:{}};
  if(!captured.ok){row.icp_score=`CAPTURE_FAILED: ${captured.error_code||"unknown"} ${captured.error_message||""}`.trim();return {row};}
  const facts = factsForProfile(captured.data);
  // icp-scoring Phase 1 — company headcount cache
  let cacheStatus="MISS & UPDATED";
  const cname=(facts.current_company||"").trim().toLowerCase();
  if(cname){if(ctx.cache.has(cname)){cacheStatus="HIT";if(!facts.company.size)facts.company.size=ctx.cache.get(cname);}else if(facts.company.size){ctx.cache.set(cname,facts.company.size);}}
  // icp-scoring Phase 2/4 — embeddings cosine, ALL math in code
  let profileVec;
  try{[profileVec]=await embed([profileEmbeddingText(facts)],{provider:ctx.cfg.embedProvider,apiKey:ctx.embedKey,model:ctx.cfg.embedModel,region:ctx.cfg.region});}
  catch(e){row.icp_score=`ICP_EMBED_ERROR: ${e.message}`;return {row};}
  const r=computeIcp(facts, profileVec, ctx.icp1Vec, ctx.icp2Vec);
  const report=buildIcpReport(facts, r, cacheStatus);
  row.icp_score=report; row.icp_total=r.total; row.raw.icp={total:r.total,verdict:verdictBand(r.total),s1:r.s1,s2:r.s2};
  if(r.total < ctx.cfg.threshold){row.persona_card=`Below threshold (${r.total} < ${ctx.cfg.threshold}) — persona & outreach not generated.`;return {row};}
  // persona-framework + email-outreach — single combined Qwen call (max efficiency)
  const {system,user,max_tokens}=personaOutreachPrompt(ctx.cfg.icpText, ctx.cfg.offerText, facts, report);
  let text;
  try{text=await chatLLM({provider:ctx.cfg.chatProvider,apiKey:ctx.qwenKey,model:ctx.cfg.chatModel,region:ctx.cfg.region,system,user,max_tokens});}
  catch(e){row.persona_card=`PERSONA_OUTREACH_ERROR: ${e.message}`;return {row};}
  const parsed=extractJson(text)||{};
  row.persona_card=feedString(parsed.persona_card);
  row.opportunity_score=Number.isFinite(Number(parsed.opportunity_score))?Math.round(Number(parsed.opportunity_score)):"";
  row.outreach_1=feedString(parsed.outreach_1); row.outreach_2=feedString(parsed.outreach_2); row.outreach_3=feedString(parsed.outreach_3);
  row.raw.persona_outreach=text;
  return {row};
}
async function finishFeed(state, stopReason){
  const results = state.feedResults || [];
  let downloadOk=false, downloadError="";
  try{const csv=buildFeedCsv(results);await chrome.storage.local.set({feedCsv:csv});await chrome.downloads.download({url:csvDataUrl(csv), filename:"lead-url-lens-feed.csv", saveAs:false});downloadOk=true;}
  catch(error){downloadError=error?.message||"download_failed";}
  await closeWorkerTab();
  const qualified = results.filter(r=>Number.isFinite(Number(r.opportunity_score))).length;
  await save({running:false, stage:downloadOk?"DONE":"FAILED", stop_reason:stopReason,
    message: downloadOk ? `Feed complete · ${results.length} rows · ${qualified} qualified (≥${state.feedThreshold}) · CSV downloaded`
      : `Feed finished but CSV export failed: ${downloadError}. Use Download CSV to retry.`});
}
async function runFeed({resume=false}={}){
  const cfg = await feedConfig();
  const qwenKey = await vaultGet("qwen");
  const embedKey = await vaultGet("embeddings");
  const state = await stored();
  let results = resume ? (state.feedResults||[]) : [];
  let index = resume ? Number(state.feedIndex||0) : 0;
  const urls = state.feedUrls || [];
  if(!Array.isArray(urls) || !urls.length){await save({running:false, stage:"FAILED", message:"No LinkedIn profile URLs were found in the file."}); return;}
  if(qwenKey===null || embedKey===null){await save({running:true, paused:true, stage:"BLOCKED", message:"Key vault is locked — unlock it with your passphrase, then press Resume."}); return;}
  if(!qwenKey){await save({running:false, stage:"FAILED", message:"Set & verify the Qwen API key before running Feed."}); return;}
  if(!embedKey){await save({running:false, stage:"FAILED", message:"Set & verify the Embeddings API key before running Feed."}); return;}
  await save({mode:"feed", running:true, paused:false, cancelled:false, feedUrls:urls, feedIndex:index, feedResults:results,
    feedThreshold:cfg.threshold, total:urls.length, done:results.length, stage:"PROCESSING",
    message: resume?"Resuming Feed analysis…":"Embedding the two ICP vectors…"});
  let icp1Vec, icp2Vec;
  try{[icp1Vec, icp2Vec] = await embed([ICP1_VECTOR_TEXT, ICP2_VECTOR_TEXT], {provider:cfg.embedProvider, apiKey:embedKey, model:cfg.embedModel, region:cfg.region});}
  catch(e){await save({running:false, stage:"FAILED", message:`Embeddings call failed: ${e.message}`}); return;}
  if(!Array.isArray(icp1Vec)||!Array.isArray(icp2Vec)){await save({running:false, stage:"FAILED", message:"Embeddings provider returned no vectors for the ICPs."}); return;}
  const ctx = {qwenKey, embedKey, cfg, icp1Vec, icp2Vec, cache:feedHeadcountCache};
  let stopReason="batch_complete";
  try{
    while(index < urls.length){
      let s=await stored(); if(s.cancelled){stopReason="cancelled";break;}
      while(s.paused){await sleep(400);s=await stored();if(s.cancelled)break;} if(s.cancelled){stopReason="cancelled";break;}
      const url = urls[index];
      await save({stage:"ANALYZE", message:`Analyzing ${index+1}/${urls.length}: ${url}`});
      let outcome;
      try{outcome = await analyzeFeedProfile(url, ctx);}
      catch(error){outcome = {row:{url, icp_score:`ERROR: ${error?.message||"analysis_failed"}`, icp_total:null, persona_card:"", opportunity_score:"", outreach_1:"", outreach_2:"", outreach_3:"", raw:{}}};}
      if(outcome.checkpoint){await save({paused:true, stage:"BLOCKED", message:"LinkedIn security checkpoint detected. Resolve it in the worker tab, then press Resume."}); return;}
      results = [...results, outcome.row]; index += 1;
      await save({feedResults:results, feedIndex:index, done:results.length, message:`Analyzed ${index}/${urls.length}`});
    }
  }catch(error){await save({running:false, stage:"FAILED", message:`Feed failed: ${error?.message||error}`}); return;}
  if(stopReason==="cancelled"){await closeWorkerTab();await save({running:false, stage:"CANCELLED", message:`Cancelled · ${results.length} analyzed. Use Download CSV for partial results.`}); return;}
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
    return{ok:true,meta,hasPassphrase:Boolean(vault.kdf&&vault.verifier),unlocked:Boolean(await vaultSessionRaw()),cfg:{chatProvider:cfg.chatProvider,chatModel:cfg.chatModel,embedProvider:cfg.embedProvider,embedModel:cfg.embedModel,region:cfg.region}};
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
    if(message.region)cfg.region=message.region;
    if(kind==="qwen"){cfg.chatProvider=message.provider||cfg.chatProvider||"qwen";cfg.chatModel=String(message.model||cfg.chatModel||"").trim();}
    else{cfg.embedProvider=message.provider||cfg.embedProvider||"qwen";cfg.embedModel=String(message.model||cfg.embedModel||"").trim();}
    await chrome.storage.local.set({feedVault:vault,feedConfig:cfg});
    const region=cfg.region||"intl";
    let verified=false,error="";
    try{
      if(kind==="qwen"){await chatLLM({provider:cfg.chatProvider,apiKey:value,model:cfg.chatModel,region,system:"You are a connection test.",user:"Reply with OK.",max_tokens:5});verified=true;}
      else{const v=await embed(["connection test"],{provider:cfg.embedProvider,apiKey:value,model:cfg.embedModel,region});verified=Array.isArray(v)&&Array.isArray(v[0])&&v[0].length>0;if(!verified)error="Provider returned no embedding vector.";}
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
    if(!meta.qwen?.set)return{ok:false,error:"Set the Qwen API key first."};
    if(!meta.embeddings?.set)return{ok:false,error:"Set the Embeddings API key first."};
    if(!(await vaultSessionRaw()))return{ok:false,error:"Unlock the key vault with your passphrase first."};
    const threshold=Math.max(0,Math.min(100,Number(message.threshold)||60));
    const cfg=(await chrome.storage.local.get("feedConfig")).feedConfig||{};
    await chrome.storage.local.set({feedConfig:{...cfg,chatProvider:message.chatProvider||cfg.chatProvider||"qwen",chatModel:String(message.chatModel||cfg.chatModel||"").trim(),embedProvider:message.embedProvider||cfg.embedProvider||"qwen",embedModel:String(message.embedModel||cfg.embedModel||"").trim(),region:message.region||cfg.region||"intl",threshold,icpText:String(message.icpText||""),offerText:String(message.offerText||"")}});
    await chrome.storage.local.remove("feedCsv");
    feedHeadcountCache.clear();
    await save({mode:"feed",feedUrls:urls.slice(0,FEED_MAX),feedIndex:0,feedResults:[],feedThreshold:threshold,total:urls.length,done:0,running:false,paused:false,cancelled:false,stage:"QUEUED",message:`Queued ${urls.length} profile(s) for Feed analysis`});
    wakeLock=true; runFeed({}).finally(()=>wakeLock=false);
    return{ok:true,count:urls.length};
  }
  if(message.type==="DOWNLOAD_FEED_CSV"){
    const state=await stored(); const results=state.feedResults||[];
    if(results.length){const csv=buildFeedCsv(results);await chrome.storage.local.set({feedCsv:csv});await chrome.downloads.download({url:csvDataUrl(csv),filename:"lead-url-lens-feed.csv"});return{ok:true};}
    const {feedCsv}=await chrome.storage.local.get("feedCsv");
    if(feedCsv){await chrome.downloads.download({url:csvDataUrl(feedCsv),filename:"lead-url-lens-feed.csv"});return{ok:true};}
    return{ok:false,error:"No Feed results to export yet."};
  }
  return {ok: true, wakeLock};
})().then(send).catch(async error => { await save({running: false, stage: "FAILED", message: error.message}); send({ok: false, error: error.message}); }); return true; });

chrome.alarms.create("lead-url-lens-heartbeat", {periodInMinutes: 0.5});
chrome.alarms.onAlarm.addListener(async alarm => { if (!["lead-url-lens-heartbeat",RUN_ALARM].includes(alarm.name)) return; const state = await stored(); if (state.running){await save({heartbeat_at: new Date().toISOString()});await resumeDurableOperation()} });
chrome.action.onClicked.addListener(async tab=>{if(!tab.id||!/^https:\/\/www\.linkedin\.com\//.test(tab.url||""))return;try{await chrome.tabs.sendMessage(tab.id,{type:"TOGGLE_PANEL"})}catch{await chrome.scripting.executeScript({target:{tabId:tab.id},files:["panel.js"]});await sleep(100);await chrome.tabs.sendMessage(tab.id,{type:"TOGGLE_PANEL"})}});
async function updateAction(tabId,url=""){if(/^https:\/\/www\.linkedin\.com\//.test(url))await chrome.action.enable(tabId);else await chrome.action.disable(tabId)}chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{if(change.url||change.status==="complete")updateAction(tabId,change.url||tab.url||"")});chrome.tabs.onActivated.addListener(async info=>{const tab=await chrome.tabs.get(info.tabId);updateAction(info.tabId,tab.url||"")});
