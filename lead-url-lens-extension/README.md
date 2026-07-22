# TechNFirms Lead URL Lens 25.5.0

## CRM-backed Offer + ICP scoring

The Feed tab and browser-side API-key vault are removed. Configure OpenAI embeddings and Qwen in the CRM, then upload ICP Markdown and Offer Markdown under **Offers & ICP**. Every Offer is associated with an immutable ICP version.

Lead collection now selects an Offer and uses the existing capture/import action. Every acknowledged import page automatically triggers backend scoring against the Offer's associated ICP. A failed or incomplete scoring run stops the extension with an explicit error after preserving the imported contacts; it never reports a successful score or invents a value. Provider credentials never enter extension storage or browser requests.

ICP Search Score is calculated only by the CRM with the fixed, auditable contract: Job Title 65 + Job Section/Headline 20 + Location 15. Company, company type, industry, website and every other field are excluded from this score and cannot block it. Rules and multilingual embeddings provide the first signals; the approved professional-role student handles validated patterns; Qwen 3.7 Plus reviews cases that are not reliably resolved and its audited decisions become versioned teacher examples for future student training. Unresolved material evidence or a blocking consistency audit produces `NOT COMPUTED`—never a misleading qualification. The extension never assigns points or bypasses the audit.

The authenticated CRM proxy contract is:

- `POST /api/extension/embed` → `{ "vectors": [[...]] }`
- `POST /api/extension/chat` → `{ "content": "..." }`
- `GET /api/extension/scoring-context` → saved Offers and ICP versions

Each request uses `Authorization: Bearer <pairing-token>`.

The extension now runs as a draggable TechNFirms launcher directly on supported LinkedIn pages. Click the square launcher to open the full-height left/right panel; drag it to another edge or minimize it at any time.

Lead collection requires an intentional import-list name or an existing CRM list. It captures every visible person card with a canonical LinkedIn profile URL. There is no profile-preview relevance filter, search policy, excluded-word rule, or LLM call in the capture workflow.

Standard LinkedIn People Search capture starts on the page the user opened and follows the rendered Next control through as many result pages as necessary. There is no fixed page limit: the requested number of new CRM contacts controls the run, with an absolute target maximum of 500. Repeated or temporarily empty pages trigger bounded reload and reinjection recovery. The open panel, form values, progress, processed pages, and acknowledged canonical profile history survive navigation and service-worker restarts. Changing to another browser tab does not interrupt capture. The run stops when the requested new-contact target is reached, LinkedIn exposes no next page, the user pauses/cancels, or a LinkedIn security checkpoint appears.

The extension resolves profile anchors from both result-card containers and the anchors themselves, checks every page against the CRM, and transfers the visible name, Headline, complete Current position Job Section, location, company, profile photo, company link/logo when exposed, canonical profile URL, source page/search, preview, and timestamp. Headline and Job Section are preserved independently; scoring uses both fields, and Job Section contains only the complete visible Poste actuel or Current position text. The CRM acknowledges each processed page before navigation, applies global canonical-URL deduplication, and counts only newly created contacts toward the target.

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
