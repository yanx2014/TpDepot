# Local Lead URL Lens 1.7.0

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

## Accuracy improvements (v1.1.0 — explicit, not silent)

The 65/20/15 weights and the deterministic rule are unchanged. What improved is how each term is *measured*:

- **Lexical exact match first (inflection-tolerant since v1.2.0).** If an accepted title/keyword appears in the prospect's text as a whole word/phrase, that term scores **1.0** directly — no embedding needed (this also rescues rows whose embeddings failed). Matching is accent- and case-insensitive, skips FR/EN function words (*de, du, chez, of, at…*), and normalizes standard French gender/plural endings so **"Fondatrice" matches "Fondateur"**, "Directrices" matches "Directeur", "Consultante" matches "Consultant". Tokens compare by equality, never substring — "directorate" still does not match "director".
- **Gender-complete variant expansion (v1.2.0).** The Qwen expansion now always emits both French masculine **and feminine** role forms, plurals, and both short-role and role+domain forms; the expansion cache is versioned so improved prompts regenerate variants for an unchanged ICP.

### v1.3.0 — generalized title-evidence matching (any industry)

All rules derive from the ICP's accepted values — nothing is hardcoded to a specific industry. The 65/20/15 weights are unchanged; what improved is where the title evidence may legitimately come from:

- **Headline counts for the Job Title term.** The 65-point term now scores the best of the extracted title and the headline (many people put a generic title in the position field and their real role in the headline). A **negation guard** ignores hits immediately preceded by *ex, ancien(ne), former, aspiring, futur(e)* — "Ex-Fondateur" never earns the points.
- **Tight gapped matching.** An accepted phrase matches within one field even with up to 3 intervening tokens ("Directeur ⟨exécutif⟩ cabinet de recrutement", "Directeur ⟨Fed Supply IDF⟩ - Cabinet de recrutement"). Full hit, unflagged.
- **Cross-field split matching.** If the accepted title's head role token appears in the title/headline and its remaining tokens all appear across title+section+headline, the term scores 1.0 — flagged `cross_field_title_match` in the Note column **and force-reviewed by Qwen** (advisory only) since the evidence is stitched together.
- **Company-name domain evidence.** A firm literally named after the ICP's domain ("Dirigeante-Fondatrice chez **Focus Recrutement**") satisfies the domain half of an accepted role+domain title. Same flag + forced advisory review. In-house look-alikes ("Directeur du recrutement chez TotalEnergies") do **not** fire this rule — the domain word must be in the company name, not the role.
- **Expansion v3.** Variants may include owner-operator equivalents ("Chef d'entreprise", "Dirigeant", "Gérant"…) only when strictly equivalent, plus essential single-token domain words as keyword variants. Cache regenerates automatically (versioned salt).
- **CSV dedupe safeguard.** Rows are deduplicated by canonical profile URL at export time.

### v1.4.0 — false-positive controls + Qualification column

- **Domain corroboration for role-only titles.** An accepted title or variant that carries none of the ICP's *specific domain tokens* (the most specific token of each accepted phrase, e.g. "recrutement") no longer scores 1.0 on its own: "Directeur Général" or "Fondateur" alone needs a domain word somewhere on the prospect's card (title/section/headline/company). With corroboration → 1.0, flagged and force-reviewed; without → falls to embeddings. ICPs that define no domain at all keep the old behavior. Note: this also applies to your own domain-less accepted titles (e.g. "Directeur des Opérations").
- **Stricter company-name evidence.** The company-name rule now requires the accepted phrase's *most specific* token in the company name ("Focus **Recrutement**" ✓; "CABINET CORRAZE" ✗ — the generic word "cabinet" alone no longer suffices).
- **Variant hygiene + visibility.** Qwen-generated variants are deterministically filtered: kept only if they share a content token with your accepted values or are a known owner-operator equivalent — "Talent Partner"-type strays are discarded. The active (filtered) variant counts are shown in the panel and stored in `localIcpActive`.
- **Wider advisory review.** Rows whose Job Title term came from embeddings only (no lexical evidence) get the advisory Qwen Review from score 40 upward with no upper cap — catching in-house look-alikes that land at 75–90. Clean lexical matches keep the 40–70 band. Verdicts never change the number.
- **Qualification column.** New CSV column after the score: `qualified` when the numeric score is ≥ **75** (`QUALIFICATION_THRESHOLD` in `feed.js`), otherwise `unqualified` (NOT COMPUTED rows are `unqualified`).

### v1.5.0 — Company column + extraction

A **Company** column, parsed from the Job Section, Headline, **and** Job Title (via `chez` / `at` / `@`). This also fixes profiles whose firm name lives only in the headline (e.g. "Directrice … @ C2P Recrutement"): the company-name domain evidence now fires and the row scores correctly.

### v1.7.0 — ICP Match phase (remaining ICP fields, qualified prospects only)

The ICP Search Score covers job title, headline keywords, and location. The rest of the ICP — **Industry**, **Company Headcount**, and the **compound AND-keyword groups** — lives on the profile and company pages. After capture+scoring, a second durable phase visits each **qualified** prospect and computes **ICP Match** (TRUE/FALSE):

- **Deep profile visit:** expands every truncated block ("…voir plus" / "see more" detected and clicked until none remain), reads the full **Infos/About** text, the latest experience (expanded), and the current-company link.
- **Company "À propos" visit:** reads **Secteur** (industry), **Taille de l'entreprise** (headcount range) and the expanded description. **Cached per company** across prospects and runs — shared employers cost one visit.
- **Deterministic evaluation per compiled ICP:** title ∈ that ICP's list (lexical matcher) ∧ tolerant industry match (LinkedIn labels ≠ ICP wording — token match first, one cached Qwen category-membership call as fallback) ∧ headcount range-intersects the ICP band ∧ every AND-keyword group present across headline+About+company description. `ICP Match = TRUE` if **any** ICP fully passes; `Matched ICP` names it; `ICP Match Details` lists the failing fields otherwise. No LLM computes the boolean.
- **Company-unavailable fallback chain:** (1) company URL searched in the **latest experience description**; (2) failing that, the **latest post/comment age** decides — activity **< 7 days** ⇒ `ICP Match TRUE` (noted `company_unavailable_recent_activity`), else `FALSE` (`…stale_activity` / `…no_activity`).
- The whole ICP document is compiled once (cached) into per-ICP structures — one or many ICPs, any industry; fields an ICP omits are skipped. Unqualified prospects are never visited (`ICP Match` blank).
- New CSV columns: **Company Industry, Company Headcount, ICP Match, Matched ICP, ICP Match Details** (18 columns total). Phase is pause/cancel/checkpoint-safe and resumable.

### v1.6.0 — Qualification is score-only again

The optional ICP-aware Qwen **fit audit** that could override Qualification (introduced in v1.5.0) has been **removed**. `Qualification` now depends **only** on the numeric score — `qualified` when score ≥ 75, else `unqualified` — so a 100 is always `qualified`. No fit audit runs, so there are **no per-prospect Qwen review calls** (Qwen is still used only for ICP prose compile + location normalization). The `Fit Verdict`, `Decision Basis`, and `Qwen Review` columns are removed.
- **Cosine calibration.** Raw embedding cosines compress the range (~0.25–0.40 even for unrelated jobs). Calibration maps cosine **≤ 0.35 → 0** and **≥ 0.80 → 1** (linear between) before the weights apply, so wrong profiles fall toward 0 and near-synonyms toward 100. Constants: `CALIBRATION` in `feed.js`.
- **ICP variant expansion (needs Qwen key).** One cached Qwen call expands your accepted titles/keywords into strict same-role variants — synonyms, abbreviations ("VP"/"Vice President"), and French/English translations ("Sales Director"/"Directeur Commercial"). Scoring takes the max over originals ∪ variants; your accepted values stay authoritative, and you can supply your own `job_title_variants` / `keyword_variants` lists in a structured ICP to skip Qwen.
- **Persistent caches.** ICP criterion embeddings, location verdicts, and Qwen reviews persist across runs in `chrome.storage.local` (same ICP → no re-embedding, consistent location decisions, fewer API calls). Profile-text embeddings are reused within a run.
- **Private/empty cards flagged.** Cards with no visible name, headline, or job section (e.g. private "LinkedIn Member" results) are exported as `NOT COMPUTED` with `private_or_empty_profile` in the **Note** column instead of a meaningless low score.
- **Advisory Qwen Review (needs Qwen key).** Borderline scores (**40–70**) get one cached Qwen audit whose verdict (`fit` / `no fit` / `uncertain` + a short reason) appears in the **Qwen Review** CSV column. It is advisory only — **it never changes the numeric score** (the LLM never assigns points).

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
Full Name;Job Title;Job Section;Headline;Company;Company Industry;Company Headcount;Location;ICP Search Score;Qualification;ICP Match;Matched ICP;ICP Match Details;Job Title (65);Job Section/Headline (20);Location (15);Note;LinkedIn Url
```

`ICP Search Score` is an integer `0–100` or `NOT COMPUTED`; `Qualification` is `qualified` (score ≥ 75) or `unqualified`; `ICP Match` is TRUE/FALSE for qualified prospects (blank = not evaluated); `Matched ICP` names the passing ICP; `ICP Match Details` lists failing fields or the fallback used; the three component columns show each sub-match as a percentage; `Note` explains flags. One row per distinct prospect (canonical-URL deduplicated).

## Install (recommended: git clone — updates without re-downloading zips)

1. Once, on your PC (requires [git](https://git-scm.com/download/win)):
   ```
   git clone https://github.com/yanx2014/TpDepot.git
   cd TpDepot
   git checkout claude/claude-chrome-chat-w2pjhz
   ```
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `TpDepot\local-lead-url-lens-extension`.
3. **To update later:** double-click `update-extension.bat` at the repo root (it runs `git pull` and prints the new version), then click the **↻ reload** icon on the extension's card in `chrome://extensions`. No zip downloads needed.

## Install (alternative: zip)

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the unzipped `local-lead-url-lens-extension` folder.
2. Open a LinkedIn People Search / Sales Navigator results tab and click the launcher.
3. Set a vault passphrase → **Unlock** → **Save & verify** your OpenAI key (and Qwen key if using prose ICP / fuzzy locations).
4. Paste your ICP, set a target, and click **Capture & score on this search**.
5. When it finishes the CSV downloads automatically (or press **Download CSV**).

The extension uses only the visible authenticated tab, stops at LinkedIn checkpoints, and never exports cookies or calls undocumented LinkedIn APIs. Your API keys never leave the browser except in direct calls to OpenAI / DashScope.
