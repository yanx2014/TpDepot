/* TechNFirms Lead URL Lens — user initiated, durable, inactive-tab, checkpoint safe. */
const MAX_TARGET = 500;
const MAX_LINKEDIN_PAGE_TRANSACTION = 10;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let wakeLock = false;

async function config() { return chrome.storage.local.get(["crm", "token"]); }
async function timedFetch(url,request,timeoutMs=30000){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);try{return await fetch(url,{...request,signal:controller.signal})}catch(error){if(error?.name==="AbortError")throw new Error("CRM synchronization is still processing. Progress remains saved; resume safely if the result does not appear.");throw error}finally{clearTimeout(timer)}}
async function api(path, options = {}) {
  const {crm, token} = await config();
  if (!crm || !token) throw new Error("Connect and verify the CRM first");
  const request = {...options, credentials: "include", headers: {"content-type": "application/json", authorization: `Bearer ${token}`, ...options.headers}};
  const timeoutMs=path.startsWith("/api/enrich")||path==="/api/extension/scoring"?120000:30000;
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
async function captureSearch({target, listName, importId=0, icpVersionId=0, offerId=0, resume = false}) {
  const prior=resume?await stored():{},tab=await resolveCaptureTab(prior,!resume),tabId=tab.id,sourceSearch=resume&&prior.sourceSearch?prior.sourceSearch:tab.url,requested=Math.min(MAX_TARGET,Math.max(1,Number(target)||50));
  if(!String(listName||"").trim())throw new Error("Import list name is required.");
  const sourceUrl=new URL(sourceSearch),page=resume?Math.max(1,Number(prior.page)||1):Math.max(1,Number(sourceUrl.searchParams.get("page"))||1);if(resume&&!await restoreCapturePage(tabId,sourceSearch,page))throw new Error("page_load_failed");
  const capture_run_id = resume && prior.capture_run_id ? prior.capture_run_id : await startRun("capture", {source_search: sourceSearch, list_name: listName, import_id:Number(importId)||0,target: requested});
  let currentPage=page,imported=Number(prior.imported||0),scored=Number(prior.scored||0),scoringRunId=Number(prior.scoringRunId||0),discovered=Number(prior.discovered||0),existing=Number(prior.existing||0),incomplete=Number(prior.incomplete||0),pagesProcessed=Number(prior.pagesProcessed||0),pageFailures=Number(prior.pageFailures||0),stopReason="search_results_complete";
  const seenProfiles=new Set(prior.processedProfiles||[]),seenFingerprints=new Set(prior.processedFingerprints||[]);let currentImportId=Number(resume?prior.importId:importId)||0;
  const selectedIcpVersionId=Number(resume?prior.icpVersionId:icpVersionId)||0;
  const selectedOfferId=Number(resume?prior.offerId:offerId)||0;
  await save({offerId:selectedOfferId});
  await save({mode:"capture",running:true,paused:false,cancelled:false,capture_run_id,target:requested,listName,importId:currentImportId,icpVersionId:selectedIcpVersionId,sourceSearch,page:currentPage,captureTabId:tabId,captureWindowId:tab.windowId,processedProfiles:[...seenProfiles],processedFingerprints:[...seenFingerprints],imported,discovered,existing,incomplete,pagesProcessed,pageFailures,message:resume?"Resumed from the last durable checkpoint":"Capturing pages until the requested new-contact target is reached",stage:"SCAN_PAGE"});
  try {
    while (imported < requested) {
      const state = await stored(); if (state.cancelled) { stopReason = "cancelled"; break; }
      while ((await stored()).paused) await sleep(250);
      const result=await capturePageWithRecovery(tabId,currentPage);
      if(result?.error_code==="linkedin_checkpoint"){stopReason="linkedin_checkpoint";throw new Error(stopReason)}
      if(result?.blocked){stopReason=result.error_code||"unsupported_search_layout";throw new Error(stopReason)}
      const page_fingerprint = result.page_fingerprint || "";
      const freshPage = !(page_fingerprint && seenFingerprints.has(page_fingerprint));
      if(page_fingerprint&&seenFingerprints.has(page_fingerprint)){
        await runEvent(capture_run_id, "page_repeat_advance", {page:currentPage, page_fingerprint});
      }
      if(freshPage){discovered+=(result.rows||[]).length;incomplete+=(result.incomplete||[]).length;pagesProcessed+=1;}
      const pageCandidates=(result.captured||[]).filter(row=>row.profile_url&&!seenProfiles.has(row.profile_url));
      let pageImported=0;
      // Import every NEW candidate on this page in bounded MAX_LINKEDIN_PAGE_TRANSACTION-sized transactions,
      // so pages that expose more than one transaction's worth of prospects are not silently dropped.
      for(let offset=0;offset<pageCandidates.length&&imported<requested;offset+=MAX_LINKEDIN_PAGE_TRANSACTION){
        const remaining=requested-imported;
        const batch=pageCandidates.slice(offset,offset+MAX_LINKEDIN_PAGE_TRANSACTION);
        const preflight=await api("/api/extension/preflight",{method:"POST",body:JSON.stringify({profile_urls:batch.map(row=>row.profile_url),offer_id:selectedOfferId,icp_version_id:selectedIcpVersionId})}),existingUrls=new Set(preflight.existing_profile_urls||[]);existing+=existingUrls.size;
        const rows=batch.filter(row=>!existingUrls.has(row.profile_url)).slice(0,remaining);
        batch.forEach(row=>seenProfiles.add(row.profile_url));
        if(!rows.length)continue;
        await save({stage:"IMPORT_PAGE",message:`Saving ${rows.length} prospect(s) to private scoring staging…`});
        const idempotency_key=`${capture_run_id}:${currentPage}:${offset}:${page_fingerprint.slice(0,64)}`;
        const response=await api("/api/extension/import",{method:"POST",headers:{"x-idempotency-key":idempotency_key},body:JSON.stringify({list_name:listName,import_id:currentImportId||undefined,icp_version_id:selectedIcpVersionId||undefined,offer_id:selectedOfferId||undefined,source_search:sourceSearch,rows,max_new:rows.length,capture_run_id,page_fingerprint,idempotency_key})});currentImportId=Number(response.import_id)||currentImportId;scoringRunId=Number(response.scoring?.id||response.scoring?.run_id||response.scoring_run_id||0)||scoringRunId;
        const added=Number(response.chunk?.added ?? response.chunk?.created ?? rows.length ?? 0);imported+=added;pageImported+=added;existing+=Number(response.chunk?.duplicates||0);
      }
      if(page_fingerprint)seenFingerprints.add(page_fingerprint);
      await runEvent(capture_run_id,"page_acknowledged",{page:currentPage,page_fingerprint,discovered:(result.rows||[]).length,captured:pageImported,incomplete:(result.incomplete||[]).length,imported,existing_crm:existing,page_failures:pageFailures});
      await save({stage:"page_acknowledged",page:currentPage,importId:currentImportId,processedProfiles:[...seenProfiles],processedFingerprints:[...seenFingerprints],imported,discovered,existing,incomplete,pagesProcessed,pageFailures,message:`Page ${currentPage}: ${imported}/${requested} prospects staged privately`});
      if (imported >= requested) { stopReason = "target_reached"; break; }
      if(!result.has_next){stopReason=(!(result.rows||[]).length&&!page_fingerprint)?"capture_yielded_no_results":"search_results_complete";break}
      await save({stage:"NEXT_PAGE"});
      const nextState=await advanceSearchPage(tabId,currentPage,page_fingerprint);if(!nextState){stopReason="search_results_complete";break}
      currentPage=Math.max(currentPage+1,Number(nextState.page)||0);await save({page:currentPage,stage:"SCAN_PAGE"});
    }
    await finishRun(capture_run_id,stopReason==="cancelled"?"cancelled":"completed",stopReason,{pages:pagesProcessed,discovered,accepted:discovered-incomplete,imported,existing,ambiguous:incomplete});
    if(scoringRunId&&stopReason!=="cancelled"){
      await save({mode:"scoring",running:true,stage:"SCORING_QUEUE",scoringRunId,importId:currentImportId,target:imported,imported,scored,notComputed:0,stop_reason:stopReason,message:`Scoring ${imported} staged prospect(s) as one cached Qwen teacher batch. Imports will publish only finalized results.`});
      await processScoringQueue({runId:scoringRunId,importId:currentImportId,maxSteps:1});
    }else if(stopReason==="capture_yielded_no_results"&&!imported){await save({running:false,stage:"DONE",stop_reason:stopReason,message:"No prospects were captured on this page. Open the LinkedIn People Search / Sales Navigator results tab, make sure results are visible and you are not on a security checkpoint, then run again."});}
    else await save({running:false,stage:"DONE",stop_reason:stopReason,message:`${imported}/${requested} new contacts imported to CRM Imports · ${stopReason.replaceAll("_"," ")}`});
  } catch (error) {
    const blocked = ["linkedin_checkpoint", "unsupported_search_layout"].includes(error.message);
    await finishRun(capture_run_id,blocked?"blocked":"failed",stopReason||error.message,{pages:pagesProcessed,discovered,accepted:discovered-incomplete,imported,existing,ambiguous:incomplete});
    await save({running: false, stage: blocked ? "BLOCKED" : "FAILED", stop_reason: stopReason || error.message, message: blocked ? `Stopped safely: ${error.message}` : error.message});
  }
}

async function processScoringQueue({runId,importId,maxSteps=1}){
  let step=0,last=null;
  while(step<maxSteps){
    const state=await stored();if(state.cancelled||state.paused)break;
    await save({mode:"scoring",running:true,stage:"SCORING_QUEUE",message:`${Number(state.imported||state.target||0)} staged privately · ${Number(state.scored||0)} finalized. Processing the next cached scoring batch…`});
    last=await api("/api/extension/scoring",{method:"POST",body:JSON.stringify({run_id:Number(runId),import_id:Number(importId)})});
    const completed=Number(last.scored||0)+Number(last.not_computed||0),total=Number(last.queued||state.imported||state.target||0);
    await save({mode:"scoring",running:!last.terminal,stage:last.terminal?"DONE":"SCORING_QUEUE",scoringRunId:Number(last.run_id||runId),importId:Number(last.import_id||importId),target:total,imported:total,scored:Number(last.scored||0),notComputed:Number(last.not_computed||0),message:last.terminal?`${Number(last.scored||0)} finalized prospect(s) published to CRM Imports${Number(last.not_computed||0)?` · ${Number(last.not_computed||0)} held outside Imports for review`:""}.`:`${completed}/${total} scoring decisions finalized privately. Imports remains unpublished until the barrier passes.`});
    if(last.terminal)return last;step+=1;
  }
  if(last&&!last.terminal)await scheduleDurableResume(500);
  return last;
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

async function resumeDurableOperation(){const state=await stored();if(!state.running||state.paused||wakeLock)return;wakeLock=true;try{if(state.mode==="capture")await captureSearch({target:state.target,listName:state.listName,importId:state.importId,icpVersionId:state.icpVersionId,offerId:state.offerId,resume:true});else if(state.mode==="scoring")await processScoringQueue({runId:state.scoringRunId,importId:state.importId,maxSteps:1});else if(state.mode==="enrichment")await enrichQueue({importId:state.importId,limit:state.target,resume:true,maxSteps:1})}finally{wakeLock=false}}

chrome.runtime.onMessage.addListener((message, _sender, send) => { (async () => {
  if (message.type === "CONNECT_TEST" || message.type === "LOAD_LISTS") {const [queueR,contextR]=await Promise.allSettled([api("/api/extension/queue?limit=1"),api("/api/extension/scoring-context")]);if(queueR.status!=="fulfilled")throw queueR.reason;const context=contextR.status==="fulfilled"?contextR.value:{};const scoringContextError=contextR.status==="fulfilled"?"":(contextR.reason?.message||"Scoring context unavailable");return {...queueR.value,...context,scoringContextError};}
  if (message.type === "VERIFY_CRM_PROXY") {const [embedding,chat]=await Promise.allSettled([api("/api/extension/embed",{method:"POST",body:JSON.stringify({input:["connection test"]})}),api("/api/extension/chat",{method:"POST",body:JSON.stringify({system:"You are a connection test.",user:"Return a JSON object with ok=true.",max_tokens:20,json:true})})]);return{ok:embedding.status==="fulfilled"&&chat.status==="fulfilled",embed:embedding.status==="fulfilled"?"ready":embedding.reason?.message||"failed",chat:chat.status==="fulfilled"?"ready":chat.reason?.message||"failed"};}
  if (message.type === "START_CAPTURE") {if(!String(message.listName||"").trim())throw new Error("Import list name is required.");if(!Number(message.offerId))throw new Error("Select an Offer configured in the CRM."); const state = await stored();if(wakeLock||state.running)return{ok:false,error:"A capture, scoring, or enrichment run is already active."};wakeLock=true;await save({running:true,mode:"capture",stage:"STARTING",message:"Starting one capture run…"});captureSearch({target: message.target, listName: message.listName,importId:message.importId,icpVersionId:message.icpVersionId,offerId:message.offerId}).finally(() => wakeLock = false);return {ok: true}; }
  if (message.type === "START_QUEUE") { const state = await stored(); if (!state.running) await beginEnrichment({importId: message.importId, limit: message.limit}); return {ok: true}; }
  if (message.type === "PAUSE_OPERATION") { await save({paused: true, message: "Paused at a safe point"}); return {ok: true}; }
  if (message.type === "RESUME_OPERATION") { await save({paused:false,running:true,cancelled:false,message:"Resuming from the last durable checkpoint…"});await resumeDurableOperation();return {ok:true}; }
  if (message.type === "CANCEL_OPERATION") { const state=await save({cancelled:true,running:false,paused:false,stage:"CANCELLED",message:"Cancelled. Any active contact is returning to the queue."});if(state.mode==="enrichment"){await releaseLease(state.currentJob,state.run_id);await closeWorkerTab();await finishRun(state.run_id,"cancelled","cancelled",{done:Number(state.done||0),failed:Number(state.failed||0)})}return {ok: true}; }
  if(message.type==="OPEN_CRM"){await chrome.tabs.create({url:message.url});return{ok:true}}
  return {ok: true, wakeLock};
})().then(send).catch(async error => { await save({running: false, stage: "FAILED", message: error.message}); send({ok: false, error: error.message}); }); return true; });

chrome.alarms.create("lead-url-lens-heartbeat", {periodInMinutes: 0.5});
chrome.alarms.onAlarm.addListener(async alarm => { if (!["lead-url-lens-heartbeat",RUN_ALARM].includes(alarm.name)) return; const state = await stored(); if (state.running){await save({heartbeat_at: new Date().toISOString()});await resumeDurableOperation()} });
chrome.action.onClicked.addListener(async tab=>{if(!tab.id||!/^https:\/\/www\.linkedin\.com\//.test(tab.url||""))return;try{await chrome.tabs.sendMessage(tab.id,{type:"TOGGLE_PANEL"})}catch{await chrome.scripting.executeScript({target:{tabId:tab.id},files:["panel.js"]});await sleep(100);await chrome.tabs.sendMessage(tab.id,{type:"TOGGLE_PANEL"})}});
async function updateAction(tabId,url=""){if(/^https:\/\/www\.linkedin\.com\//.test(url))await chrome.action.enable(tabId);else await chrome.action.disable(tabId)}chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{if(change.url||change.status==="complete")updateAction(tabId,change.url||tab.url||"")});chrome.tabs.onActivated.addListener(async info=>{const tab=await chrome.tabs.get(info.tabId);updateAction(info.tabId,tab.url||"")});
