# Local Lead URL Lens 1.0.0

A standalone Manifest V3 extension that **captures LinkedIn People Search / Sales Navigator prospects and scores them locally against your ICP, then downloads a CSV** — with **no backend and no CRM**. It is a separate extension from the CRM-connected *Lead URL Lens*; nothing here talks to `lead-url-lens-crm…chatgpt.site`.

## What it does

1. You open a LinkedIn **People Search** (or **Sales Navigator**) results tab.
2. You set your ICP, your OpenAI key (and optionally a Qwen key), and a prospect target.
3. It captures visible prospect cards page by page — **using the exact same capture rules** as the CRM extension (`search-content.js` is byte-for-byte identical) — following the rendered *Next* control, with the same reload/re-injection recovery, checkpoint safety, and durable resume across tab changes and service-worker restarts.
4. It **scores each captured prospect locally**, in the browser.
5. When the run finishes (target reached, no next page, or you cancel) it **downloads `local-lead-icp-scores.csv`**. You can also press **Download CSV** at any time for partial results.

## Scoring rule (unchanged — stated explicitly, not silent)

The score reproduces the documented contract **exactly** and computes it **deterministically in code** (the LLM never assigns points):

```
ICP Search Score = 65 · jobTitleMatch  +  20 · jobSectionHeadlineMatch  +  15 · locationMatch
```

Each term is in `[0,1]`; the weights **65 / 20 / 15 are fixed** (they are the contract, not taken from your ICP).

- **Job Title (65)** — best cosine similarity between the prospect's current job title (from the *Poste actuel / Current position* Job Section, else parsed from the headline) and your ICP's accepted job titles.
- **Job Section/Headline (20)** — best cosine similarity between the prospect's *Job Section + Headline* text and your ICP's accepted titles ∪ keywords.
- **Location (15)** — `1.0` if an accepted location equals or contains the displayed location; `0.5`/`0` via one cached Qwen normalization if a Qwen key is set; otherwise `0`.

Semantic matches use **OpenAI `text-embedding-3-small`** (the contract mandates embeddings; it is never substituted). If a required embedding cannot be produced for a prospect, that row is **`NOT COMPUTED`** — never an invented value, exactly as the backend behaves.

## Keys (local, encrypted, no backend)

Because there is no backend to hold credentials, the keys live in a **local passphrase-gated vault**: a passphrase you enter once per browser session derives an AES-256 key (PBKDF2, 210k iterations, SHA-256) that encrypts your API keys (AES-GCM) at rest; the derived key lives only in `chrome.storage.session`.

- **OpenAI API key — required** (embeddings). Without it, scoring cannot run and rows are `NOT COMPUTED`.
- **Qwen API key — optional.** Used only to (a) compile a prose ICP into accepted values and (b) normalize unresolved locations. If you paste a **structured ICP JSON** and your locations resolve by exact/containment, no Qwen key is needed.

Keys are write-only in the UI (**Save & verify** stores them encrypted and runs a live connection test); they are never displayed again.

## ICP formats

Paste text, choose a file, or set a raw URL. Either:

- **Prose / Markdown** — compiled once (cached) by Qwen into accepted values, or
- **Structured JSON**:

```json
{ "criteria": { "job_titles": ["…"], "keywords": ["…"], "locations": ["…"] } }
```

(`job_titles` / `keywords` / `locations` at the top level also work.)

## Output CSV

`local-lead-icp-scores.csv` — UTF-8, **semicolon-delimited**, columns:

```
Full Name;Job Title;Job Section;Headline;Location;ICP Search Score;Job Title (65);Job Section/Headline (20);Location (15);LinkedIn Url
```

`ICP Search Score` is an integer `0–100` or `NOT COMPUTED`; the three component columns show each sub-match as a percentage. One row per distinct prospect (canonical-URL deduplicated).

## Install

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `local-lead-url-lens-extension` folder.
2. Open a LinkedIn People Search / Sales Navigator results tab and click the launcher.
3. Set a vault passphrase → **Unlock** → **Save & verify** your OpenAI key (and Qwen key if using prose ICP / fuzzy locations).
4. Paste your ICP, set a target, and click **Capture & score on this search**.
5. When it finishes the CSV downloads automatically (or press **Download CSV**).

The extension uses only the visible authenticated tab, stops at LinkedIn checkpoints, and never exports cookies or calls undocumented LinkedIn APIs. Your API keys never leave the browser except in direct calls to OpenAI / DashScope.
