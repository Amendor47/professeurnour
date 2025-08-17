{{> _system_common }}

But: extraire les thèmes, définitions clés, formules, étapes, erreurs fréquentes.
Niveaux Bloom: Rappel, Compréhension, Application, Analyse.
Entrées:
- query: "{{topic_or_empty}}"
- passages: {{retrieved_passages_json}}

Réponds JSON: { "status":"ok|insufficient_context",
  "themes":[{"title": "...","summary":"...","quotes":[{"passage_id":"...","text":"..."}],"key_terms":["..."],"formulas":["..."],"common_mistakes":["..."]}] }
Contraintes:
- 3–8 thèmes max.
- `quotes` = extraits exactement issus des passages.
