import json
from fastapi.testclient import TestClient
from server.app import app

client = TestClient(app)

def test_health():
    r = client.get('/health')
    assert r.status_code == 200 and r.json().get('status') == 'ok'

def test_validate_mcq_schema():
    payload = {"status":"ok","items":[{"id":"x","difficulty":"easy","bloom":"rappel","question":"Quelle est la bonne ?","options":["a","b","c","d"],"answer_index":0,"rationale":"","distractors_rationale":"","citations":["p1"]}]}
    r = client.post('/validate/mcq', json=payload)
    assert r.status_code == 200 and r.json().get('ok') is True

def test_rag_retrieve():
    body = {"text":"A B C D E F G H I J K L M N O P Q R"*50, "query":"D E F", "k": 4}
    r = client.post('/rag/retrieve', json=body)
    assert r.status_code == 200 and isinstance(r.json().get('passages'), list)

def test_validate_sheet_schema():
    payload = {
        "status": "ok",
        "sheets": [
            {
                "title": "Lois de Newton",
                "short_version": {"type":"bullet_points","content":["Inertie","F=ma","Action-réaction"]},
                "medium_version": {"type":"paragraphs","content":["Définition et principes."]},
                "long_version": {"type":"developed","content":"Introduction. La première loi explique l'inertie. La seconde loi relie force, masse et accélération. La troisième loi introduit les forces en paire. Exemples et implications pratiques."},
                "citations": ["p1","p2"]
            }
        ]
    }
    r = client.post('/validate/sheet', json=payload)
    assert r.status_code == 200 and r.json().get('ok') is True
