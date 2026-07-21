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


## Feed workflow — ICP scoring

The **Feed** tab scores a list of LinkedIn profiles against a user-defined ICP and exports a CSV. It implements the generalized `icp-scoring` skill (`icp-scoring-skill/` in this repo): OpenAI embeddings + deterministic rules in code; the LLM never computes the score.

### Passphrase-gated key vault

Keys are protected by a **passphrase you enter once per browser session** — never stored. It derives an AES-256 key via **PBKDF2** (210k iterations, SHA-256) that encrypts your API keys (AES-GCM) at rest. **Unlock** each session (the derived key lives only in `chrome.storage.session`, so it survives service-worker restarts but clears when the browser closes); **Lock** clears it now; **Change** re-encrypts under a new passphrase. Keys can only be set/used while unlocked.

### Keys

- **OpenAI API key — embeddings.** Used exclusively for `text-embedding-3-small` (the skill mandates it; never substituted). Required.
- **Qwen API key — ICP compile + location normalization.** Compiles the `icps.md` prose into the scoring schema (one cached call) and normalizes unresolved locations. Model configurable (default `qwen3.7-plus`), with a **DashScope region** toggle (International / China). Optional if you paste a structured ICP JSON and all locations resolve exactly.

Both keys are write-only in the UI: press **Save & verify** to store encrypted + run a live connection test (🔒 *Configured & connection verified*); the field then shows only `••••••••`.

### Inputs

- **Profiles file** — `LINKS_TO_ANALYZE.md`: local file or raw URL; every `linkedin.com/in/…` or `/sales/lead/…` URL is scored, de-duplicated (up to 1000).
- **ICP definition** — `icps.md`: prose/Markdown (auto-compiled to the schema via Qwen) or a structured ICP JSON per `icp-scoring-skill/references/icp-schema.md`.

### Scoring (deterministic, in code)

Criteria and default weights: **job_titles 60 / locations 25 / keywords 15**, normalized to 100.
- **job_titles** — max cosine(profile payload, each accepted title) via OpenAI embeddings. Payload = Job Section + Headline.
- **keywords** — lexical match first (phrase / whole-token / synonyms, stopwords rejected, `minimum_matches` / `match_mode`); embeddings only as fallback.
- **locations** — exact/containment against accepted values → 1.0; else one cached Qwen normalization call → 1.0 / 0.5 (partial) / 0.
- If embeddings can't run for a profile → score = `NOT COMPUTED` (never estimated by an LLM).

### Output

`icp-scores.csv` — UTF-8, **semicolon-delimited**, columns exactly:

```
Full Name;Job Section;Headline;Location;ICP Search Score;LinkedIn Url
```

Score is an integer 0–100 or `NOT COMPUTED`. One row per distinct result, canonical-URL deduplicated. **Download CSV** re-exports (including partial results after pause/cancel). The run is durable (survives service-worker restarts), pauses on LinkedIn checkpoints, and closes its worker tab when finished.

> Persona-card and outreach generation are **not** part of this workflow — the Feed is now pure ICP scoring per the new skill.

## Install (Feed / dev)

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, select the `lead-url-lens-extension` folder.
2. In the Feed tab: set a vault passphrase → **Unlock** → **Save & verify** the OpenAI key (and Qwen key) → choose the profiles + ICP files → **Run ICP scoring**.
