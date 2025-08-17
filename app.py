from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import re, unicodedata
from collections import Counter

app = FastAPI(title="Coach Local API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

@app.get("/health")
def health():
    return {"status": "ok"}

class ExtractIn(BaseModel):
    urls: Optional[List[str]] = None
    prompt: Optional[str] = None
    schema: Optional[Dict[str, Any]] = None
    text: Optional[str] = None
    content: Optional[str] = None

def _norm(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii","ignore").decode().lower()

@app.post("/v1/extract")
def extract(inp: ExtractIn):
    text = (inp.text or inp.content or "").strip()
    if not text:
        return {"data": {"notions_cles": [], "definitions": [], "questions": []}}

    tokens = re.findall(r"[A-Za-zÀ-ÿ]{3,}", text)
    stop = set("le la les de des du un une et ou a au aux en dans pour par avec sans sur sous entre d l que qui quoi dont est sont ete été etre être ce cet cette ces il elle nous vous on ne pas".split())
    toks = [_norm(t) for t in tokens if _norm(t) not in stop]
    cnt = Counter(toks)
    notions = [w for w,_ in cnt.most_common(12)]

    lines = [l.strip() for l in text.splitlines() if l.strip()]
    defs = []
    for l in lines:
        if re.search(r"(définition|se définit|est|consiste en)", l, re.I):
            defs.append(l[:220])
            if len(defs) >= 8:
                break

    questions = [f"Expliquez la notion: « {w} »." for w in notions[:6]]
    return {"data": {"notions_cles": notions, "definitions": defs, "questions": questions}}
