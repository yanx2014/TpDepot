---
name: email-outreach
description: Draft the 3-email French cold outreach sequence (Pattern Interrupt main email, Value-Add Nudge follow-up, Diagnostic Break-up) for a recruitment-sector prospect (cabinet de recrutement), using their filled Persona Card and the Recruteur Augmenté Offer to fill in the hook, pain, and proof variables. Use when asked to write a cold email, outreach message, follow-up email, or breakup/close-the-loop email for a prospect in this niche.
---

# High-Conversion Email Framework

Source: `reference/High_Conversion_Email_Framework.pdf`. Integrates the Offer
(`../../../docs/recruitment-niche/offer-recruteur-augmente.md`) and a completed Persona Card
(output of the `persona-framework` skill).

## Core rules of engagement

- **The 3-Second Hook:** first sentence must prove you're not a bot — use data from Persona Card
  Section 2 (Content Themes / Posts-Comments) or Section 3 (Company Hiring/News).
- **The "Peer-to-Peer" Tone:** write like a fellow operator, not a vendor. Use "nous avons remarqué" /
  "beaucoup de gérants nous disent", never "I am an expert who can fix your business."
- **Specific Value Prop (if ICP match):** tie directly to the Offer's Dream Outcome and Risk Reversal
  (e.g. "automatiser l'admin tout en garantissant la conformité CNIL").
- **Diagnostic Value Prop (if ICP mismatch/unsure):** ask a question that surfaces a hidden cost
  (e.g. "Comment vos nouveaux recruteurs gèrent-ils le volume de tri de CV sans s'épuiser ?").
- **Low-Friction CTA:** never ask for 30 minutes upfront — ask for interest or direction.

## Email 1 — Main Outreach ("Pattern Interrupt")

Goal: spark curiosity, prove relevance, offer a specific low-risk next step.

Subject line options (keep boring/internal):
- "Question regarding [Company Name]'s recruitment process"
- "[Prospect First Name], quick question on your team's capacity"
- "CNIL compliance & recruiter admin time"

Body template (French):

```
Bonjour [Prénom],

J'ai vu votre récent post sur [Persona Card §2 theme, e.g. la difficulté de trouver des
profils IT en ce moment] / J'ai remarqué que [Company Name] recrutait activement
[Persona Card §3 hiring need].

Beaucoup de gérants de cabinets que nous accompagnons nous disent qu'ils passent près
de 60% de leur temps sur des tâches administratives (tri de CV, coordination
d'entretiens) au lieu de faire du closing, tout en s'inquiétant des nouvelles
contraintes CNIL sur l'usage de l'IA.

Nous aidons les cabinets à mettre en place des agents IA simples et 100% conformes RGPD
pour automatiser ces tâches. L'objectif n'est pas de remplacer vos consultants, mais de
leur faire gagner environ 10h par semaine.

Seriez-vous ouvert à un échange de 15 minutes pour voir si une approche similaire
pourrait libérer du temps pour votre équipe, sans aucun risque pour vos données ?

Bien à vous,
[Your Name]
```

Why it works: hook proves you did the Phase 2/3 research; value prop is specific (60% admin time,
CNIL fear); humility ("l'objectif n'est pas de remplacer"); low-friction CTA (15 min, "voir si c'est un fit").

## Email 2 — Follow-Up 1 ("Value-Add Nudge")

Timing: 3–4 days after Email 1. Shorter than Email 1.

Subject: `Re: [Original Subject]` or `Une idée pour [Company Name]`

```
Bonjour [Prénom],

Je me permets de relancer brièvement ce sujet.

En voyant que vous développez votre équipe chez [Company Name], je me demandais :
comment vos nouveaux consultants gèrent-ils le volume de tri de CV aujourd'hui ?

Nous avons récemment mis en place un petit flux d'automatisation pour un cabinet
similaire qui réduit ce temps de screening de moitié, tout en gardant un contrôle
humain total (et conforme).

Si c'est un sujet d'actualité pour vous, je serais ravi de vous partager un exemple
concret de 2 minutes. Sinon, aucun souci, je ne vous relancerai pas.

Bonne journée,
[Your Name]
```

Why it works: diagnostic pivot with a specific operational question; offers a "2-minute concrete
example" micro-asset instead of a meeting; "sinon, aucun souci" removes pressure, which paradoxically
increases reply rates.

## Email 3 — Follow-Up 2 ("Diagnostic Break-up")

Timing: 5–7 days after Email 2. Goal: strip the line, show respect for their time, leave the door open.

Subject: `Dernière tentative` / `Clôturer le dossier ?`

```
Bonjour [Prénom],

Je n'ai pas eu de retour de votre part, je suppose donc que l'optimisation du temps
administratif via l'IA n'est pas une priorité pour [Company Name] en ce moment, ou que
vous avez déjà des processus bien rodés.

Je vais donc clore ce dossier de mon côté pour ne pas encombrer votre boîte mail.

Si jamais la question de l'automatisation conforme RGPD revient sur la table dans les
prochains mois, n'hésitez pas à me faire signe.

Je vous souhaite une excellente continuation dans vos recrutements.

Cordialement,
[Your Name]
```

Why it works: genuine scarcity/loss aversion ("je clos ce dossier"); humility (acknowledges they might
already have good processes — an honorable out); no invented competence — exits gracefully while
planting a seed for the future.

## Filling the templates from a Persona Card

Before drafting Email 1, pull from the prospect's completed Persona Card (see `persona-framework`
skill):

1. **Hook variable** ← Persona Card Section 2 (Content Themes) or Section 3 (Internal Gaps/Hiring
   Needs) → first sentence.
2. **Pain variable** ← Persona Card Section 4 (Primary Operational Pains) → e.g. "CV screening" or
   "scheduling", mentioned explicitly.
3. **Competence check** ← Persona Card Section 5 (Required Proof to Convert) → if they need to see
   "data anonymization", Email 2's example must speak to that.

Strictly tying email variables to Persona Card data eliminates generic "spray and pray" outreach.
