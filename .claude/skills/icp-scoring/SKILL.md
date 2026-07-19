---
name: icp-scoring
description: Score a LinkedIn profile (0-100) against the two Merged ICPs for French recruitment cabinets (Scaling Independent Cabinet / High-Margin Niche Executive Search) using semantic embedding similarity plus hard structural rules (location, headcount, industry), and output the standardized LinkedIn Profile ICP Analysis Report. Use when asked to score, qualify, rank, filter, or triage recruitment-sector leads/prospects against the ICP, or process a CSV/list of LinkedIn profiles for fit.
---

# Automated ICP Scoring Framework

Source: `reference/Automated_ICP_Scoring.pdf`. The two ICPs referenced below are the verbatim
Merged ICPs — full copy at `../../../docs/recruitment-niche/icps.md`.

Builds an automated agent that evaluates LinkedIn profiles, computes an ICP score (0-100) using
embeddings, and manages company data caching. Four operational phases: Data Ingestion & Caching,
Semantic Embedding, Structural Validation, Score Computation.

## Phase 1: Data Ingestion & Caching (the "Fetch" layer)

Extract only the **Minimal Semantic Payload** from the target LinkedIn profile:
- `profile_preview_text` — text summary/preview near the full name.
- `profile_description` — the "About" section or headline text.
- `current_job_title` — the exact current job title.
- `company_name` — the name of the current employer.

**Company headcount cache check:**
- Query the local cache using `company_name` as key.
- Cache HIT → retrieve `cached_employee_count`.
- Cache MISS → navigate to the Company LinkedIn Page, extract the employee count range
  (e.g., "11-50 employés"), save `{ "company_name": "X", "employee_count": "11-50 employés" }`
  to the cache, and use it as `current_employee_count`.

## Phase 2: Semantic Embedding & Comparison (the "Brain" layer)

1. **ICP vectors** (pre-computed, embed titles + keywords):
   - **Vector ICP 1** (Scaling Independent Cabinet): "Fondateur", "Co-fondateur", "Gérant",
     "Managing Partner", "Directeur d'agence", "Directeur des Opérations", "cabinet de recrutement",
     "chasseur de tête", "conseil en recrutement", "croissance", "IA", "automatisation", "RGPD",
     "conformité".
   - **Vector ICP 2** (High-Margin Niche / Executive Search): "Associé", "Partner", "Fondateur",
     "Directeur de cabinet", "Directeur Général", "cabinet de chasse", "executive search",
     "recherche de cadres", "headhunting", "cabinet de recrutement spécialisé", "nous recrutons",
     "développement", "digital".
2. **Profile vector:** combine `profile_preview_text` + `profile_description` + `current_job_title`
   into one string, generate its embedding (`Vector Profile`).
3. **Cosine similarity:**
   - `Score_Semantic_1 = cosine(Vector Profile, Vector ICP 1)` (0.0–1.0)
   - `Score_Semantic_2 = cosine(Vector Profile, Vector ICP 2)` (0.0–1.0)
   - `Max_Semantic = max(Score_Semantic_1, Score_Semantic_2)`

## Phase 3: Structural Validation (the "Gatekeeper" layer)

Embeddings are bad at exact numbers — apply hard logic rules:
1. **Location check:** does profile/company location contain "France", "Paris", "Lyon", etc.? (bool)
2. **Headcount match** against `current_employee_count` (ICP1: 11-50, ICP2: 1-50):
   - Exact match → True
   - Adjacent match (e.g. profile 51-200 vs ICP1 11-50) → Partial
   - No match (e.g. 200+) → False

## Phase 4: ICP Score Computation (0–100)

`Total ICP Score = Semantic Weight + Headcount Weight + Location/Industry Weight`

| Component | Max | Rule |
|---|---|---|
| Semantic Weight | 60 | `Max_Semantic * 60` (e.g. cosine 0.85 → 51 pts) |
| Headcount Weight | 25 | Exact match to ICP1/ICP2 range = 25; adjacent (e.g. 51-200 vs 11-50) = 10; no match (e.g. 1000+) = 0 |
| Location & Industry Weight | 15 | France + HR/Recruitment industry = 15; one right one wrong = 5; neither = 0 |

Note: a 100% semantic match with 10,000 employees still lands at 60/100 — headcount correctly
demotes them despite looking like the right persona.

## Output: LinkedIn Profile ICP Analysis Report

```
====================================================================
 LINKEDIN PROFILE ICP ANALYSIS REPORT
====================================================================
1. PROFILE IDENTITY & EXTRACTED DATA
- Full Name:
- Current Title:
- Company Name:
- Profile Preview/Description Summary:
- Minimal Semantic Payload Extracted:

2. COMPANY CONTEXT & CACHE STATUS
- Company Name:
- Employee Count:
- Cache Status: [HIT / MISS & UPDATED]
- Industry Detected:
- Location Detected:

3. SEMANTIC EMBEDDING ANALYSIS
- Vector ICP 1 (Scaling Cabinet) Similarity: [0.00-1.00]
- Vector ICP 2 (Niche/Exec Search) Similarity: [0.00-1.00]
- Primary ICP Match: [ICP 1 or ICP 2]
- Semantic Alignment Notes:

4. STRUCTURAL VALIDATION (HARD FILTERS)
- Location Match (France): [YES / NO]
- Industry Match (HR/Recruitment): [YES / NO]
- Headcount Match (1-50 or 11-50): [EXACT / ADJACENT / NO MATCH]

5. FINAL ICP SCORE & VERDICT
- Semantic Score: [XX] / 60
- Headcount Score: [XX] / 25
- Location/Industry Score: [XX] / 15
--------------------------------------------------------------------
TOTAL ICP SCORE: [ XX / 100 ]
====================================================================
ACTIONABLE VERDICT:
- [80-100] HOT: Immediate outreach. Highly aligned semantically and structurally.
- [60-79] WARM: Good fit, but [state the missing point]. Proceed with cautious outreach.
- [40-59] COLD: Lacks semantic alignment or structural fit. Nurture or ignore.
- [<40] REJECT: Not an ICP match. Discard.

AGENT RECOMMENDATION:
[1 sentence on the best approach angle based on the semantic payload]
====================================================================
```

## Implementation rules (if wiring this into Make/n8n/Python)

1. **Embedding model:** use a multilingual model (`text-embedding-3-small` OpenAI, or
   `multilingual-e5-large` HuggingFace) since profile text and ICPs are in French.
2. **Cache database:** simple key-value store (Redis, Supabase, or local JSON/SQLite) mapping
   `company_name -> employee_count`.
3. **LLM's job:** never let the LLM calculate the scores — compute all math in code. Only pass it the
   structured data (scores, cache status, payload) to generate the qualitative
   "AGENT RECOMMENDATION" line and format the final report exactly per the template above.

## Note on live LinkedIn scraping

This framework assumes access to profile/company data (via an authorized scraping tool, LinkedIn
API partner, or enrichment provider). Anonymous fetches of linkedin.com/in/... URLs return an authwall
(HTTP 403) — this skill does not itself bypass that; it defines the scoring logic to apply once profile
data has been legitimately obtained.
