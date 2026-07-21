# ICP configuration schema

Use this configuration contract. Omit criteria the user does not supply.

```yaml
icp:
  name: User-defined ICP
  criteria:
    job_titles:
      type: semantic
      values: []
      weight: 60
      required: true
    locations:
      type: location
      values: []
      weight: 25
      required: true
      partial_score: 0.5
    keywords:
      type: keyword
      values: []
      weight: 15
      required: false
      match_mode: any
      token_match_allowed: true
      minimum_matches: 1
      synonyms: {}
  gates: []
```

## Criterion behavior

- `semantic`: compare the profile payload with each accepted value using `text-embedding-3-small`; use the maximum cosine similarity.
- `location`: exact match first, then cache, then minimal Qwen normalization. Return exact, inferred, partial, no-match, or unknown.
- `keyword`: use phrases/tokens/supplied synonyms first, then embeddings. Ignore stopwords.
- `numeric_range`: parse and compare bounds in code.
- `enumeration`: normalize and compare allowed labels.
- `boolean`: parse explicit evidence in code.

Weights must be non-negative and are normalized to total 100. A required criterion with missing evidence receives zero; do not redistribute its weight.

## Example: ICP_short0

```yaml
icp:
  name: ICP_short0
  criteria:
    job_titles:
      type: semantic
      values:
        - Fondateur
        - Co-fondateur
        - Gérant
        - Managing Partner
        - Directeur d'agence
        - Directeur des Opérations
      weight: 60
      required: true
    locations:
      type: location
      values: [France]
      weight: 25
      required: true
    keywords:
      type: keyword
      values:
        - cabinet de recrutement
        - chasseur de tête
        - conseil en recrutement
        - croissance
        - IA
        - automatisation
        - RGPD
        - conformité
      weight: 15
      required: false
      match_mode: any
      token_match_allowed: true
      minimum_matches: 1
```
