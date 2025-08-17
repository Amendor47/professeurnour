{{> _system_common }}

But: proposer un plan SRS (10 jours) basé sur difficulté, erreurs et oubli estimé.
Entrées: { "items_stats":[{"id":"", "difficulty":"easy|medium|hard", "last_result":"correct|incorrect", "last_seen":"ISO8601"}] }

Réponds JSON: {"status":"ok", "schedule":[{"id":"", "next_review":"ISO8601", "priority":0..1}]}
