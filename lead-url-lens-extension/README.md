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

### Passphrase-gated key vault

Keys are protected by a **passphrase you enter once per browser session** — the passphrase is never stored.

- Set a passphrase (**Create**) the first time. It derives an AES-256 key via **PBKDF2** (210k iterations, SHA-256) that encrypts your API keys (AES-GCM) at rest.
- Each browser session, **Unlock** with the passphrase. The derived key lives only in memory (`chrome.storage.session`), so it survives service-worker restarts but clears when the browser closes — you re-unlock next session. **Lock** clears it immediately; **Change** re-encrypts the stored keys under a new passphrase (while unlocked).
- Without the passphrase the stored keys are unreadable — this is real per-secret protection, not obfuscation.

### Keys

- **Qwen API key** — reasoning (persona + outreach). Provider defaults to Qwen/DashScope (`qwen-plus`); OpenAI selectable.
- **Embeddings API key** — ICP semantic scoring. Provider defaults to Qwen `text-embedding-v3`; OpenAI `text-embedding-3-small` selectable.

You must unlock the vault before setting a key. Press **Save & verify** and the extension encrypts the key, runs a **live connection test**, and shows 🔒 *Configured & connection verified*. Once set the field shows only `••••••••` (write-only); re-enter to replace, or **Clear** to remove.

### DashScope region toggle

**International (`dashscope-intl.aliyuncs.com`)** by default, or **China (`dashscope.aliyuncs.com`)** — the toggle switches the base host for all Qwen chat + embeddings calls. If a key verification fails with an auth error, try the other region.

### Inputs

- **Profiles file** — `LINKS_TO_ANALYZE.md`: local file or raw URL. Every `linkedin.com/in/…` or `/sales/lead/…` URL is analyzed, in order, de-duplicated (up to 1000).
- **ICP definition** — `icps.md`: the two Merged ICPs.
- **Offer doc** (optional) — grounds persona §5 and the outreach value props.
- **Threshold** — ICP score (0–100) at/above which persona + outreach run. Default 60.

### Per profile

1. **ICP scoring** (skill: `icp-scoring`) — captures the Minimal Semantic Payload + company headcount (cached by company name), embeds it, and computes the score **entirely in code** (semantic cosine ×60 + headcount 25 + location/industry 15). No LLM touches the math — this is both the skill rule and the efficient path. Produces the verbatim **LinkedIn Profile ICP Analysis Report**.
2. **Persona + outreach** (skills: `persona-framework` + `email-outreach`) — only when the score ≥ threshold. A **single Qwen call** builds the full 6-section Persona Card with the 30/40/30 Opportunity Score, then the three French emails (Pattern Interrupt / Value-Add Nudge / Diagnostic Break-up), grounded in the persona card, the offer, and only observed facts. Posts/comments follow the skill's X=5 / 12−X=7 rule.

### What gets captured, and where (per skill)

The Feed uses a **graceful "lite" capture** (`CAPTURE_PROFILE_LITE`): the always-rendered top-card facts are read first, then the Experience section best-effort. A missing Experience section **no longer discards the whole profile** — ICP scoring only needs the top-card facts, so the row still gets a score (persona depth degrades). Only a real authwall / checkpoint (no name) fails a row.

| Skill | Data it needs | Where it comes from |
|---|---|---|
| **icp-scoring** | Minimal Semantic Payload (headline, title, company), location; company headcount/industry/HQ | Top card `h1` + `.text-body-medium` (headline) + `.text-body-small` (location); current **title & company fall back to the headline** (`"… at/chez/@ Company"`) when Experience isn't captured; headcount/industry from the company **About** page |
| **persona-framework** | §1 Professional DNA (roles, tenure, descriptions); §2 posts + comments; §3 company context | Experience card (found by `#experience` anchor → heading text → content fallback; grouped roles inherit the company); `/recent-activity/posts` (5) and `/comments` (7); company **About** page |
| **email-outreach** | hook / pain / proof variables | Derived from the completed Persona Card + the offer doc |

Experience-section detection is now three-layered (stable anchor id, exact "Expérience/Experience" heading, then a content fallback that finds the card holding the most company-anchor + dated items), and the Feed capture **briefly activates the worker tab on retry** so LinkedIn's lazy-loaded Experience list actually renders (hidden tabs often never populate it) — the fix for the `experience_section_not_found` failures.

The run is durable (survives service-worker restarts via the heartbeat alarm), pauses on LinkedIn checkpoints, and closes its worker tab when finished.

**Output:** `lead-url-lens-feed.csv` — the source URL plus **ICP Score** (the full analysis report), **Persona Card**, **Opportunity Score**, **Outreach 1/2/3** — verbatim skill output per row. **Download CSV** re-exports (including partial results after a pause or cancel).

The scoring math, structural rules, ICP keyword vectors, and prompt templates live in `feed.js` (`computeIcp`, `buildIcpReport`, `personaOutreachPrompt`, `ICP1_VECTOR_TEXT` / `ICP2_VECTOR_TEXT`) and can be edited in place.
