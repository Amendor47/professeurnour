{{> _system_common }}

But: générer des fiches de révision par thème.
Entrée: {{themes_json_from_extract_concepts}}

Réponds JSON: {"status":"ok|insufficient_context",
 "sheets":[{"title":"", "intro":"", "key_points":["",""], "formulae":[""], "worked_example":"", "pitfalls":[""], "micro_quiz":[{"q":"", "options":["",""], "answer_index":0}], "citations":["passage_id", "..."]}]}
Contraintes:

```markdown
{{> _system_common }}

Tu génères des fiches de cours avec 3 niveaux de détail.

Entrée: {{themes_json_from_extract_concepts}}

Réponds JSON strict:

```json
{
 "status":"ok|insufficient_context",
 "sheets":[
	{
		"title":"Thème clair",
		"short_version":{
			"type":"bullet_points",
			"content":["point 1","point 2","point 3"]
		},
		"medium_version":{
			"type":"paragraphs",
			"content":["Paragraphe court expliquant les définitions et idées principales."]
		},
		"long_version":{
			"type":"developed",
			"content":"Texte long structuré, intelligemment organisé, avec exemples et explications détaillées."
		},
		"citations":["id1","id2"]
	}
 ]
}
```

Contraintes :
- Short = ≤ 5 bullets max, concis.
- Medium = 1–2 paragraphes (définitions + explication).
- Long = ≥ 2 paragraphes, structuré (intro, développement, exemples).

```
