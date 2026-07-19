---
name: persona-framework
description: Build a deeply-researched buyer persona for a French recruitment-sector prospect (cabinet de recrutement / executive search) from their LinkedIn Experience, posts/comments, and company site, then fill out the full Persona Card and compute the 4-part Opportunity Score (0-100). Use when asked to build/create a persona, profile a prospect, "run the persona framework", research a LinkedIn contact for the Recruteur Augmenté offer, or fill out a "Persona Card".
---

# Persona Framework — 4-Phase Buyer Persona Builder

Source: `reference/Persona_Framework_Card.pdf`. Ground scoring in the ICPs at
`../../../docs/recruitment-niche/icps.md` and the value props in
`../../../docs/recruitment-niche/offer-recruteur-augmente.md`.

This framework moves from the individual's professional reality to their psychological drivers,
contextualizes them within their company's strategy, and finally quantifies their buying probability.

## Phase 1: Professional DNA (The "Who")

**Data source:** prospect's latest LinkedIn Experience section.
**Objective:** career trajectory, seniority, operational scope, past achievements → their day-to-day
reality and KPIs.

Actions:
- Extract current and past roles to map career progression (e.g., operational recruiting → management?).
- Identify tenure in current role (stability vs. recent promotion).
- Extract listed skills and specific achievements/descriptions to see what they're officially measured on.

## Phase 2: Behavioral & Mindset Signals (The "Why")

**Data source:** prospect's latest LinkedIn posts and their comments on others' posts.
**Objective:** true priorities, thought leadership, communication style, hidden objections.

**The "X & 12-X" logic:**
1. Define X = number of recent posts to analyze, X_max = 7, recommended X = 5 (balances depth/speed).
2. Analyze the X posts: core themes, tone of voice, what they publicly champion (culture, tech adoption,
   candidate experience, etc.).
3. Analyze `12 - X` comments left by the prospect on *other people's* posts (if X=5, that's 7 comments).
   Comments reveal how they actually interact — what they agree/disagree with, unfiltered opinions.
   Look for patterns in how they praise, critique, or add value to peers.

## Phase 3: Organizational Context (The "Where")

**Data source:** company's digital footprint — website primary, company LinkedIn page as fallback.
**Objective:** business model, strategic goals, market positioning → align individual pain with company
macro pain.

Primary (company website):
- Sitemap crawl to identify core architecture.
- Targeted page analysis against 4 pillars: (1) About Us / Leadership — culture, mission, founder vision;
  (2) Services / Solutions / Expertise — value proposition, target market; (3) Careers / Join Us — what
  roles are open (reveals internal gaps/growth areas); (4) Blog / Insights / Press — market positioning,
  current strategic focus.

Fallback (company LinkedIn page) — trigger when the website is inaccessible, outdated, or lacks the
target pages:
- Extract Headcount, Industry, Specialties, Tagline.
- Apply the same X-posts / (12-X)-comments logic from Phase 2, but to the **company page**.

## Phase 4: The Opportunity Score (The "How Likely") — calculate LAST

**Data source:** synthesis of Phases 1–3 + the Offer + the ICPs.
**Objective:** quantify buying likelihood, 0–100.

| Component | Max | Based on |
|---|---|---|
| ICP Fit | 30 pts | How well title, company size, industry match the Merged ICPs |
| Pain & Trigger Alignment | 40 pts | Phase 2 + Phase 1 — do they exhibit the exact pains the Offer solves? Recent trigger events (hiring sprees, complaints about admin work, posts about AI/RGPD)? |
| Authority & Budget | 30 pts | Phase 1 + Phase 3 — decision-making power and financial health (growth/margins) to buy |
| **Total** | **100** | **Opportunity Score** |

## The Persona Card Template

Copy this template per prospect. Fill every field; if data is unavailable, write
`"Data unavailable, inferred as [X]"` rather than omitting it.

```
SECTION 1: CORE IDENTITY & PROFESSIONAL DNA
- Full Name:
- Current Title:
- Company:
- Company Size & Industry:
- Location:
- Tenure in Current Role:
- Career Trajectory Summary:
- Core KPIs / Responsibilities:

SECTION 2: BEHAVIORAL & MINDSET PROFILE (Phase 2)
- Content Themes (from X posts):
- Communication Style & Tone:
- Peer Interaction & Values (from 12-X comments):
- Stated Beliefs / Philosophies:

SECTION 3: ORGANIZATIONAL CONTEXT (Phase 3)
- Company Value Proposition:
- Strategic Focus / Current Goals:
- Company Culture & Vibe:
- Internal Gaps / Hiring Needs:
- Tech Stack / Tools Mentioned:

SECTION 4: PAIN POINTS & BUYING TRIGGERS
- Primary Operational Pains:
- Strategic / Business Pains:
- Hidden Objections / Fears:
- Recent Trigger Events:

SECTION 5: ALIGNMENT WITH OUR OFFER
- Dream Outcome for THIS Persona:
- How Our Offer Solves Their Specific Pain:
- Required Proof to Convert:

SECTION 6: THE OPPORTUNITY SCORE (0-100) — calculate last
- ICP Fit Score: [__/30]
- Pain & Trigger Score: [__/40]
- Authority & Budget Score: [__/30]
- TOTAL OPPORTUNITY SCORE: [ XX / 100 ]

Final Strategic Note: [1-2 sentences on the single best angle to approach this person]
```

## Score Interpretation & Next Action

- **80–100 (Hot):** Immediate priority. Send personalized video/voice note referencing their specific
  post/comment. Push for the 30-min Audit.
- **60–79 (Warm):** Strong fit. Send standard personalized cold email referencing company growth and
  specific pain point.
- **40–59 (Lukewarm):** Nurture. Connect on LinkedIn, engage with their posts for 2 weeks before pitching.
- **< 40 (Cold):** Deprioritize. Does not fit ICP or lacks budget/authority. Remove from active outreach queue.

## Handoff

A completed Persona Card is the direct input to the `email-outreach` skill (Sections 2–5 map to the
Hook, Pain, and Competence-Check variables in the email templates).
