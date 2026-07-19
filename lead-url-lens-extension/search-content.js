(() => {
  if (globalThis.__TECHNFIRMS_SEARCH_RECEIVER__) return;
  globalThis.__TECHNFIRMS_SEARCH_RECEIVER__ = true;
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const checkpoint = () => /security verification|quick security check|checkpoint|vérification de sécurité|connectez-vous|sign in/i.test((document.body?.innerText || "").slice(0, 25000));
  const imageUrl = element => { const value = element?.currentSrc || element?.src || ""; return /^https:\/\//i.test(value) ? value : ""; };
  const canonical = raw => { try { const url = new URL(raw); const standard = url.pathname.match(/^\/in\/([^/?#]+)/i), sales = url.pathname.match(/^\/sales\/lead\/([^/?#]+)/i); if (standard) return `https://www.linkedin.com/in/${decodeURIComponent(standard[1]).toLowerCase()}`; if (sales) return `https://www.linkedin.com/sales/lead/${sales[1]}`; return ""; } catch { return ""; } };
  const lines = card => String(card.innerText || "").split(/\n+/).map(clean).filter(Boolean);
  const relationshipNoise = value => /^[\s•·]*(?:1er|1re|2e|3e|1st|2nd|3rd)(?:\s+et\s*\+)?[\s•·]*$/i.test(clean(value));
  function personName(value) {
    let name=clean(value).replace(/\s*[•·]\s*(?:1er|1re|2e|3e|1st|2nd|3rd)(?:\s+et\s*\+)?\s*$/i,"");
    if(/\brecrute\b/i.test(name))name=clean(name.split(/\brecrute\b/i)[0]);
    const words=name.split(/\s+/).filter(Boolean),half=words.length/2;
    if(Number.isInteger(half)&&half>0&&words.slice(0,half).join(" ").toLocaleLowerCase()===words.slice(half).join(" ").toLocaleLowerCase())name=words.slice(0,half).join(" ");
    return clean(name);
  }
  const profileLinkSelector='a[href*="linkedin.com/in/"],a[href^="/in/"],a[href*="/sales/lead/"]';
  const mainProfileLinkSelector=profileLinkSelector.split(",").map(selector=>`main ${selector}`).join(",");
  const cardSelector="li.reusable-search__result-container,li.artdeco-list__item,[role='listitem'],[data-chameleon-result-urn],[data-entity-urn*='member'],.artdeco-entity-lockup,[data-x-search-result]";
  function profileAnchor(node){if(node?.matches?.(profileLinkSelector)&&canonical(node.href||""))return node;return[...(node?.querySelectorAll?.(profileLinkSelector)||[])].find(anchor=>canonical(anchor.href||""))||null}
  function cardFromAnchor(anchor){const card=anchor?.closest?.(cardSelector);return card&&document.querySelector("main")?.contains(card)?card:anchor?.closest?.("li")||anchor?.parentElement||anchor}

  function uniqueCards(nodes) {
    const byUrl = new Map();
    const candidates=[...nodes];
    for(const anchor of document.querySelectorAll(mainProfileLinkSelector)){const card=cardFromAnchor(anchor);if(card)candidates.push(card)}
    for (const node of candidates) {
      if (!visible(node)) continue;
      const anchor = profileAnchor(node), url = canonical(anchor?.href || "");
      if (!url) continue;
      const prior = byUrl.get(url);
      if (!prior || clean(node.innerText).length > clean(prior.innerText).length) byUrl.set(url, node);
    }
    return [...byUrl.values()];
  }
  class StandardSearchAdapter {
    supports() { return location.pathname.startsWith("/search/results/people"); }
    cards() {
      const selectors = [
        "main li.reusable-search__result-container",
        "main li.artdeco-list__item",
        "main [data-view-name='search-entity-result-universal-template']",
        "main [data-view-name*='search-entity-result']",
        "main [data-chameleon-result-urn]",
        "main [data-entity-urn*='member']",
      ];
      return uniqueCards(document.querySelectorAll(selectors.join(",")));
    }
    nextButton() { return [...document.querySelectorAll("button,a")].find(control => visible(control) && !control.disabled && control.getAttribute("aria-disabled")!=="true" && /\b(next|next page|suivant|suivante|page suivante)\b/i.test(clean(control.getAttribute("aria-label") || control.textContent))); }
  }
  class SalesNavigatorAdapter {
    supports() { return location.pathname.startsWith("/sales/search/people"); }
    cards() { return uniqueCards(document.querySelectorAll("main li, main [data-x-search-result], main [data-view-name*='search-result']")); }
    nextButton() { return [...document.querySelectorAll("button,a")].find(control => visible(control) && !control.disabled && control.getAttribute("aria-disabled")!=="true" && /next|suivant/i.test(clean(control.getAttribute("aria-label") || control.textContent))); }
  }
  const adapter = () => [new StandardSearchAdapter(), new SalesNavigatorAdapter()].find(candidate => candidate.supports());
  const resultContainer = () => document.querySelector("main [role='main'], main ul, main [role='list'], main") || document.body;

  async function waitForStableResults() {
    const selected = adapter(), root = resultContainer();
    if (!selected || !root) return;
    let changedAt = performance.now(), lastCount = selected.cards().length;
    const observer = new MutationObserver(() => { changedAt = performance.now(); });
    observer.observe(root, {childList: true, subtree: true});
    const deadline = performance.now() + 3200;
    try {
      while (performance.now() < deadline) {
        const count = selected.cards().length;
        if (count !== lastCount) { lastCount = count; changedAt = performance.now(); }
        window.scrollTo({top: document.documentElement.scrollHeight, behavior: "instant"});
        if (count > 0 && performance.now() - changedAt > 450) break;
        await sleep(120);
      }
    } finally {
      observer.disconnect();
      window.scrollTo({top: 0, behavior: "instant"});
    }
  }
  async function scrollUntilStable(){return waitForStableResults();}

  function extract(card, index) {
    const profileAnchorNode = profileAnchor(card), profile_url = canonical(profileAnchorNode?.href || ""), all = lines(card);
    const nameCandidates=[
      card.querySelector("[data-anonymize='person-name']")?.textContent,
      ...[...(profileAnchorNode?.querySelectorAll?.("span[aria-hidden='true']")||[])].map(node=>node.textContent),
      profileAnchorNode?.getAttribute("aria-label"),profileAnchorNode?.textContent,all[0]
    ].map(personName).filter(value=>value&&!relationshipNoise(value));
    const full_name = nameCandidates.sort((left,right)=>left.length-right.length)[0]||"";
    const headlineSelectors = ["[data-anonymize='headline']", ".entity-result__primary-subtitle", ".artdeco-entity-lockup__subtitle", "[data-field='headline']", "[class*='entity-result__primary-subtitle']"];
    const headlineNode=headlineSelectors.map(selector => card.querySelector(selector)).find(visible);
    const headline = clean(headlineNode?.textContent || all.find((line, position) => position > 0 && !relationshipNoise(line) && personName(line).toLocaleLowerCase()!==full_name.toLocaleLowerCase() && !/^(message|se connecter|connect|suivre|follow)$/i.test(line)) || "");
    const locationText = clean(card.querySelector("[data-anonymize='location'], .entity-result__secondary-subtitle, .artdeco-entity-lockup__caption")?.textContent || all.find(line => /france|paris|lyon|london|belgique|suisse|remote|région|area/i.test(line)) || "");
    const currentLine = all.find(line => /poste actuel|current position| chez | at /i.test(line)) || "";
    const companyFromHeadline = headline.match(/(?:\s+chez\s+|\s+at\s+|\s+@)([^|·•]+)/i)?.[1] || "";
    const company = clean(card.querySelector("[data-anonymize='company-name']")?.textContent || companyFromHeadline || currentLine.replace(/^.*?(?:chez|at)\s+/i, "").split(/[·•]/)[0]);
    const companyAnchor=card.querySelector('a[href*="/company/"]'),companyImage=companyAnchor?.querySelector("img");
    return {capture_index:index+1,source_page:Number(new URL(location.href).searchParams.get("page"))||1,full_name,headline,company,location:locationText,profile_url,source_profile_url:profileAnchorNode?.href||"",profile_photo_url:imageUrl(card.querySelector("img")),company_profile_url:companyAnchor?.href||"",company_logo_url:imageUrl(companyImage),profile_preview:headline,source_search:location.href,collected_at:new Date().toISOString()};
  }
  function pageState() { const selected=adapter(),cards=selected?.cards()||[],urls=cards.map(card=>canonical(profileAnchor(card)?.href||"")).filter(Boolean).sort();return{ready:Boolean(selected&&(urls.length||cards.length)),page_fingerprint:urls.join("|"),result_count:urls.length,page:Number(new URL(location.href).searchParams.get("page"))||1,has_next:Boolean(selected?.nextButton())}; }
  async function capture() {
    if (checkpoint()) return {blocked:true,error_code:"linkedin_checkpoint"};
    const selected=adapter(); if(!selected)return{blocked:true,error_code:"unsupported_search_layout"};
    await scrollUntilStable();
    const rows=selected.cards().map(extract),captured=rows.filter(row=>row.profile_url),incomplete=rows.filter(row=>!row.profile_url||!row.full_name);
    const urls=rows.map(row=>row.profile_url).filter(Boolean).sort(),page_fingerprint=urls.join("|")||clean(document.querySelector("main")?.textContent).slice(0,500);
    const valid_previews=rows.filter(row=>row.profile_preview).length,missing_urls=rows.filter(row=>!row.profile_url).length,duplicate_cards=rows.length-new Set(rows.map(row=>row.profile_url).filter(Boolean)).size-missing_urls;
    return{source_search:location.href,page_fingerprint,rows,valid_previews,missing_urls,duplicate_cards:Math.max(0,duplicate_cards),has_next:Boolean(selected.nextButton()),captured:captured,incomplete:incomplete};
  }
  async function nextPage(){const selected=adapter(),button=selected?.nextButton();if(!button)return{advanced:false,reason:"sales_results_complete"};button.click();return{advanced:true};}
  chrome.runtime.onMessage.addListener((message,_sender,send)=>{
    if(message.type==="SEARCH_RECEIVER_PING"){send({ready:true});return false;}
    if(message.type==="GET_SEARCH_PAGE_STATE"){send(pageState());return false;}
    if(message.type==="CAPTURE_VISIBLE_SEARCH"){capture().then(send).catch(error=>send({blocked:true,error_code:"capture_failed",error_message:error.message}));return true;}
    if(message.type==="ADVANCE_SEARCH_PAGE"){nextPage().then(send);return true;}
    return false;
  });
})();
