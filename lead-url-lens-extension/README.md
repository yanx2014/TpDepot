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

The **Feed** tab runs an end-to-end analysis of a list of LinkedIn profiles and exports a CSV. It runs entirely in your browser and calls an LLM API directly with a key you provide.

Inputs:

- **LLM provider + API key** — Anthropic (default, model `claude-opus-4-8`) or OpenAI. The key is stored locally in the extension and used only for the analysis calls. An optional model field overrides the default.
- **Profiles file** — `LINKS_TO_ANALYZE.md`: choose a local file or paste a raw URL (e.g. a GitHub raw link). Every `linkedin.com/in/…` or `/sales/lead/…` URL in the file is analyzed, in order, de-duplicated (up to 1000).
- **ICP definition** — `icps.md`: a local file or raw URL describing the Ideal Customer Profile.
- **Threshold** — the ICP score (0–100) at or above which persona and outreach are generated. Default 60.

For each profile the extension captures the profile facts from LinkedIn (headline, current role, experience history, recent posts/comments, and company "About"), then runs three grounded skills:

1. **ICP scoring** — scores the profile 0–100 against `icps.md`.
2. **Persona framework** (only if score ≥ threshold) — a persona card plus an opportunity score.
3. **Email outreach** (only if score ≥ threshold) — three distinct outreach messages.

The run is durable (survives service-worker restarts via the heartbeat alarm), pauses on LinkedIn checkpoints, and closes its worker tab when finished. Every model prompt is instructed to use only the captured facts and never invent data.

**Output:** a `lead-url-lens-feed.csv` download whose columns are the source URL plus **ICP Score, Persona Card, Opportunity Score, Outreach 1, Outreach 2, Outreach 3** — the verbatim skill output saved in each row. Use **Download CSV** to re-export (including partial results after a pause or cancel).

The skill prompts live in `feed.js` (`icpScoringPrompt`, `personaPrompt`, `outreachPrompt`) and can be edited in place to match your own ICP-scoring, persona, and outreach definitions. ICP scoring uses an LLM rubric grounded in the captured facts; swap in a cosine-embeddings pre-filter there if you prefer true embeddings (add an embeddings key).
