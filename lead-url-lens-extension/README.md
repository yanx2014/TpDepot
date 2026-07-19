# TechNFirms Lead URL Lens 11.0.0

The extension now runs as a draggable TechNFirms launcher directly on supported LinkedIn pages. Click the square launcher to open the full-height left/right panel; drag it to another edge or minimize it at any time.

Lead collection requires an intentional import-list name or an existing CRM list. It captures every visible person card with a canonical LinkedIn profile URL. There is no profile-preview relevance filter, search policy, excluded-word rule, or LLM call in the capture workflow.

Standard LinkedIn People Search capture starts on the page the user opened and follows the rendered Next control through as many result pages as necessary. There is no fixed page limit: the requested number of new CRM contacts controls the run, with an absolute target maximum of 500. Repeated or temporarily empty pages trigger bounded reload and reinjection recovery. The open panel, form values, progress, processed pages, and acknowledged canonical profile history survive navigation and service-worker restarts. Changing to another browser tab does not interrupt capture. The run stops when the requested new-contact target is reached, LinkedIn exposes no next page, the user pauses/cancels, or a LinkedIn security checkpoint appears.

The extension resolves profile anchors from both result-card containers and the anchors themselves, checks every page against the CRM, and transfers the visible name, headline, company, location, profile photo, company link/logo when exposed, canonical profile URL, source page/search, preview, and timestamp. The CRM acknowledges each processed page before navigation, applies global canonical-URL deduplication, and counts only newly created contacts toward the target.

One Manifest V3 extension for two user-initiated workflows:

- Capture and immediately import relevant contacts from visible LinkedIn People Search or Sales Navigator result pages.
- Enrich a selected CRM import list in fixed internal chunks of 100, up to a user-selected maximum of 500 contacts.

## Install

1. Download `lead-url-lens-extension.zip` from the CRM Imports or Enrichment Center page.
2. Extract it locally.
3. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
4. Select the extracted folder.
5. Create a pairing token in the CRM and enter it once in the extension.

The token is verified before use and is hidden after connection. Collection uses only the visible authenticated tab, stops at LinkedIn checkpoints, and never exports cookies or calls undocumented LinkedIn APIs.

## Feed workflow

The **Feed** tab runs an end-to-end analysis of a list of LinkedIn profiles and exports a CSV. It runs entirely in your browser and implements the three recruitment-niche skills (`.claude/skills/icp-scoring`, `persona-framework`, `email-outreach`).

### Keys (encrypted, write-only)

- **Qwen API key** — reasoning (persona + outreach). Provider defaults to Qwen/DashScope (`qwen-plus`); OpenAI selectable.
- **Embeddings API key** — ICP semantic scoring. Provider defaults to Qwen `text-embedding-v3`; OpenAI `text-embedding-3-small` selectable.

Both keys are **AES-GCM encrypted at rest** and never returned to the UI. Press **Save & verify** and the extension stores the key encrypted, runs a live connection test, and shows 🔒 *Configured & connection verified*. Once set, the field shows only `••••••••`; re-enter a value to replace it, or **Clear** to remove it. (The encryption is obfuscation-grade — it keeps keys out of plaintext storage, but is not an OS keychain.)

> DashScope defaults to the **international** endpoint (`dashscope-intl.aliyuncs.com`). If your key is China-region, that verification will fail — tell us and we'll switch the base URL.

### Inputs

- **Profiles file** — `LINKS_TO_ANALYZE.md`: local file or raw URL. Every `linkedin.com/in/…` or `/sales/lead/…` URL is analyzed, in order, de-duplicated (up to 1000).
- **ICP definition** — `icps.md`: the two Merged ICPs.
- **Offer doc** (optional) — grounds persona §5 and the outreach value props.
- **Threshold** — ICP score (0–100) at/above which persona + outreach run. Default 60.

### Per profile

1. **ICP scoring** (skill: `icp-scoring`) — captures the Minimal Semantic Payload + company headcount (cached by company name), embeds it, and computes the score **entirely in code** (semantic cosine ×60 + headcount 25 + location/industry 15). No LLM touches the math — this is both the skill rule and the efficient path. Produces the verbatim **LinkedIn Profile ICP Analysis Report**.
2. **Persona + outreach** (skills: `persona-framework` + `email-outreach`) — only when the score ≥ threshold. A **single Qwen call** builds the full 6-section Persona Card with the 30/40/30 Opportunity Score, then the three French emails (Pattern Interrupt / Value-Add Nudge / Diagnostic Break-up), grounded in the persona card, the offer, and only observed facts. Posts/comments follow the skill's X=5 / 12−X=7 rule.

The run is durable (survives service-worker restarts via the heartbeat alarm), pauses on LinkedIn checkpoints, and closes its worker tab when finished.

**Output:** `lead-url-lens-feed.csv` — the source URL plus **ICP Score** (the full analysis report), **Persona Card**, **Opportunity Score**, **Outreach 1/2/3** — verbatim skill output per row. **Download CSV** re-exports (including partial results after a pause or cancel).

The scoring math, structural rules, ICP keyword vectors, and prompt templates live in `feed.js` (`computeIcp`, `buildIcpReport`, `personaOutreachPrompt`, `ICP1_VECTOR_TEXT` / `ICP2_VECTOR_TEXT`) and can be edited in place.
