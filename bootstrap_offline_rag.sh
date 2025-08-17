set -euo pipefail

echo "[1/5] Clean duplicates"
rm -rf server tests || true
mkdir -p .copilot db server/providers server/embeddings server/vectorstores server/rag tests
: > server/__init__.py
: > server/providers/__init__.py
: > server/embeddings/__init__.py
: > server/vectorstores/__init__.py
: > server/rag/__init__.py

echo "[2/5] Write requirements/Makefile/config"
cat > requirements.txt << 'R'
fastapi>=0.110
uvicorn[standard]>=0.23
pydantic>=2.0
PyYAML>=6.0
sentence-transformers>=2.2
faiss-cpu>=1.7.4
transformers>=4.41
ctransformers>=0.2.27
numpy>=1.24
R

cat > Makefile << 'M'
run:
    uvicorn server.app:app --host 127.0.0.1 --port 3002 --reload

test:
    pytest -q
M

cat > config.yml << 'C'
llm: ctransformers
ctransformers:
  model: TheBloke/Wizard-Vicuna-7B-Uncensored-GGML
  model_file: Wizard-Vicuna-7B-Uncensored.ggmlv3.q4_0.bin
  model_type: llama
  config:
    gpu_layers: 0
huggingface:
  model: TheBloke/Wizard-Vicuna-7B-Uncensored-HF
  device: null   # 0 pour GPU
embeddings:
  model: sentence-transformers/all-MiniLM-L6-v2
  model_kwargs:
    device: cpu   # ou cuda
vectorstore:
  backend: faiss
  path: db
rag:
  k: 4
  chunk_size: 800
  chunk_overlap: 120
  rerank: false
C

echo "[3/5] Copilot super-prompt"
cat > .copilot/offline-llm-overhaul.md << 'P'
# /.copilot/offline-llm-overhaul.md
Tu es Copilot. Objectif: refactorer et enrichir l’inférence LLM offline interne (RAG local) en t’inspirant des capacités de ChatDocs: backends multiples (CTransformers/HF/GPTQ), config YAML fusionnée, GPU, API Web. 100% hors-ligne, ne casse pas /v1/extract.
P

echo "[4/5] Server files"
cat > server/config_loader.py << 'PY'
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict
import os, yaml, pathlib, copy

DEFAULTS = {
    "llm": "ctransformers",
    "ctransformers": {"model": "TheBloke/Wizard-Vicuna-7B-Uncensored-GGML","model_file": None,"model_type": "llama","config": {"gpu_layers": 0}},
    "huggingface": {"model": "TheBloke/Wizard-Vicuna-7B-Uncensored-HF", "device": None},
    "embeddings": {"model": "sentence-transformers/all-MiniLM-L6-v2", "model_kwargs": {"device": "cpu"}},
    "vectorstore": {"backend": "faiss", "path": "db"},
    "rag": {"k": 4, "chunk_size": 800, "chunk_overlap": 120, "rerank": False}
}

@dataclass
class AppConfig:
    data: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, path: str = "config.yml") -> "AppConfig":
        base = copy.deepcopy(DEFAULTS)
        if pathlib.Path(path).exists():
            with open(path, "r", encoding="utf-8") as f:
                user = yaml.safe_load(f) or {}
            base = _deep_merge(base, user)
        if m := os.getenv("LLM_MODEL"):
            base.setdefault("ctransformers", {})["model"] = m
            base.setdefault("huggingface", {})["model"] = m
        if d := os.getenv("EMBED_DEVICE"):
            base.setdefault("embeddings", {}).setdefault("model_kwargs", {})["device"] = d
        return cls(base)

def _deep_merge(a: Dict[str, Any], b: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(a)
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out
PY

cat > server/providers/base.py << 'PY'
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Iterable

class BaseLLMProvider(ABC):
    @abstractmethod
    def generate(self, prompt: str, **params) -> str: ...
    @abstractmethod
    def stream(self, prompt: str, **params) -> Iterable[str]: ...
PY

cat > server/providers/ctransformers_provider.py << 'PY'
from __future__ import annotations
from typing import Iterable
from .base import BaseLLMProvider

class CTransformersProvider(BaseLLMProvider):
    def __init__(self, model: str, model_file: str | None, model_type: str, config: dict):
        from ctransformers import AutoModelForCausalLM
        kwargs = {"model": model, "model_type": model_type}
        if model_file: kwargs["model_file"] = model_file
        if config: kwargs.update(config)
        self._model = AutoModelForCausalLM.from_pretrained(**kwargs)

    def generate(self, prompt: str, **params) -> str:
        return self._model(prompt, **params)

    def stream(self, prompt: str, **params) -> Iterable[str]:
        yield from self._model(prompt, stream=True, **params)
PY

cat > server/providers/hf_provider.py << 'PY'
from __future__ import annotations
from typing import Iterable, Optional
from .base import BaseLLMProvider

class HFProvider(BaseLLMProvider):
    def __init__(self, model: str, device: Optional[int] = None):
        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch  # noqa: F401
        self.tok = AutoTokenizer.from_pretrained(model, use_fast=True)
        device_map = "auto" if device is not None else None
        self.model = AutoModelForCausalLM.from_pretrained(model, torch_dtype="auto", device_map=device_map)

    def generate(self, prompt: str, **params) -> str:
        import torch
        inputs = self.tok(prompt, return_tensors="pt").to(self.model.device)
        out = self.model.generate(**inputs, max_new_tokens=params.get("max_tokens", 256), temperature=params.get("temperature", 0.2))
        return self.tok.decode(out[0], skip_special_tokens=True)

    def stream(self, prompt: str, **params) -> Iterable[str]:
        from transformers import TextIteratorStreamer
        import threading
        inputs = self.tok(prompt, return_tensors="pt").to(self.model.device)
        streamer = TextIteratorStreamer(self.tok, skip_prompt=True)
        kw = dict(max_new_tokens=params.get("max_tokens", 256), temperature=params.get("temperature", 0.2), streamer=streamer)
        thread = threading.Thread(target=self.model.generate, kwargs={**inputs, **kw})
        thread.start()
        for token in streamer: yield token
        thread.join()
PY

cat > server/embeddings/factory.py << 'PY'
from __future__ import annotations
from typing import List, Dict, Any
import numpy as np

class EmbeddingFactory:
    def __init__(self, model: str, model_kwargs: Dict[str, Any] | None = None):
        from sentence_transformers import SentenceTransformer
        self.model = SentenceTransformer(model, **(model_kwargs or {}))

    def encode(self, texts: List[str], batch_size: int = 32) -> np.ndarray:
        return np.asarray(self.model.encode(texts, batch_size=batch_size, convert_to_numpy=True, show_progress_bar=False))
PY

cat > server/vectorstores/faiss_store.py << 'PY'
from __future__ import annotations
from typing import List, Dict, Any, Tuple
import os, json, numpy as np
import faiss

class FAISSStore:
    def __init__(self, path: str = "db"):
        self.path = path; os.makedirs(path, exist_ok=True)
        self.meta_path = os.path.join(path, "meta.json")
        self.index_path = os.path.join(path, "index.faiss")
        self.index = None
        self.meta: List[Dict[str, Any]] = []

    def load(self, dim: int) -> None:
        if os.path.exists(self.index_path):
            self.index = faiss.read_index(self.index_path)
            if os.path.exists(self.meta_path):
                with open(self.meta_path, "r", encoding="utf-8") as f: self.meta = json.load(f)
            else:
                self.meta = []
        else:
            self.index = faiss.IndexFlatIP(dim); self.meta=[]

    def add(self, vectors: np.ndarray, metadatas: List[Dict[str, Any]]) -> None:
        if self.index is None: self.load(vectors.shape[1])
        faiss.normalize_L2(vectors)
        self.index.add(vectors)
        self.meta.extend(metadatas)
        faiss.write_index(self.index, self.index_path)
        with open(self.meta_path, "w", encoding="utf-8") as f: json.dump(self.meta, f, ensure_ascii=False)

    def search(self, query: np.ndarray, k: int = 4) -> List[Tuple[int, float]]:
        if self.index is None: self.load(query.shape[1])
        faiss.normalize_L2(query)
        D, I = self.index.search(query, k)
        return [(int(i), float(d)) for i, d in zip(I[0], D[0]) if i != -1]

    def get(self, idx: int) -> Dict[str, Any]:
        return self.meta[idx]
PY

cat > server/rag/chain.py << 'PY'
from __future__ import annotations
from typing import List, Dict
from ..embeddings.factory import EmbeddingFactory
from ..vectorstores.faiss_store import FAISSStore

class RagChain:
    def __init__(self, embed: EmbeddingFactory, store: FAISSStore, llm):
        self.embed, self.store, self.llm = embed, store, llm

    def ingest(self, docs: List[Dict[str, str]], chunk_size=800, overlap=120):
        chunks, metas = [], []
        for d in docs:
            text = d.get("text",""); src = d.get("source","user")
            step = max(1, chunk_size - overlap)
            for i in range(0, len(text), step):
                ch = text[i:i+chunk_size]
                if ch.strip():
                    chunks.append(ch); metas.append({"source": src, "i": i})
        if not chunks:
            return
        X = self.embed.encode(chunks)
        self.store.add(X, [{"text": c, **m} for c, m in zip(chunks, metas)])

    def answer(self, question: str, k=4, **gen):
        qv = self.embed.encode([question])
        hits = self.store.search(qv, k=k)
        ctx = "\n\n".join(self.store.get(i)["text"] for i,_ in hits)
        prompt = f"Contexte:\n{ctx}\n\nQuestion: {question}\nRéponse concise en français:"
        text = self.llm.generate(prompt, **gen)
        return {"text": text, "context": [self.store.get(i) for i,_ in hits]}
PY

cat > server/app.py << 'PY'
from __future__ import annotations
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
from .config_loader import AppConfig
from .providers.ctransformers_provider import CTransformersProvider
from .providers.hf_provider import HFProvider
from .embeddings.factory import EmbeddingFactory
from .vectorstores.faiss_store import FAISSStore
from .rag.chain import RagChain
import json, re

app = FastAPI(title="Offline LLM API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

cfg = AppConfig.load().data
if cfg.get("llm", "ctransformers") == "huggingface":
    p = cfg["huggingface"]; LLM = HFProvider(p["model"], device=p.get("device"))
else:
    p = cfg["ctransformers"]; LLM = CTransformersProvider(p["model"], p.get("model_file"), p.get("model_type", "llama"), p.get("config", {}))

E = EmbeddingFactory(cfg["embeddings"]["model"], cfg["embeddings"].get("model_kwargs"))
VS = FAISSStore(cfg["vectorstore"]["path"]); VS.load(dim=E.encode(["_"]).shape[1])
RAG = RagChain(E, VS, LLM)

class ChatReq(BaseModel): messages: List[dict]; params: Optional[dict] = None
class EmbedReq(BaseModel): texts: List[str]
class IndexReq(BaseModel): documents: List[dict]; chunk_size: Optional[int] = None; chunk_overlap: Optional[int] = None
class ExtractReq(BaseModel): text: str

@app.get("/health")
def health(): return {"ok": True}

@app.post("/v1/chat")
def v1_chat(req: ChatReq):
    prompt = "\n".join([m.get("content","") for m in req.messages])
    out = LLM.generate(prompt, **(req.params or {}))
    return {"text": out}

@app.post("/v1/embeddings")
def v1_embeddings(req: EmbedReq):
    X = E.encode(req.texts).tolist()
    return {"embeddings": X}

@app.post("/v1/index")
def v1_index(req: IndexReq):
    cs = req.chunk_size or cfg["rag"]["chunk_size"]
    ov = req.chunk_overlap or cfg["rag"]["chunk_overlap"]
    RAG.ingest(req.documents, chunk_size=cs, overlap=ov)
    return {"ok": True}

@app.post("/v1/extract")
def v1_extract(req: ExtractReq):
    text = (req.text or "")[:4000]
    prompt = f"""Tu es un professeur. À partir du texte suivant, donne:
- notions_cles (5-8 puces)
- definitions (2-5 items)
- questions (3-6 questions ouvertes)
Texte:
{text}
Réponds en JSON avec ces clés."""
    raw = LLM.generate(prompt, max_tokens=512, temperature=0.2)
    try:
        import re, json
        match = re.search(r"\{[\s\S]*\}", raw)
        data = json.loads(match.group(0)) if match else {}
    except Exception:
        data = {}
    data.setdefault("notions_cles", [])
    data.setdefault("definitions", [])
    data.setdefault("questions", [])
    return data
PY

cat > tests/test_pipeline.py << 'PY'
def test_config_loads():
    from server.config_loader import AppConfig
    cfg = AppConfig.load().data
    assert "embeddings" in cfg and "vectorstore" in cfg

def test_embed_roundtrip(tmp_path):
    from server.embeddings.factory import EmbeddingFactory
    from server.vectorstores.faiss_store import FAISSStore
    E = EmbeddingFactory("sentence-transformers/all-MiniLM-L6-v2")
    VS = FAISSStore(str(tmp_path)); VS.load(E.encode(["x"]).shape[1])
    VS.add(E.encode(["hello"]), [{"text":"hello"}])
    hits = VS.search(E.encode(["hello"]), k=1)
    assert hits and VS.get(hits[0][0])["text"] == "hello"
PY

echo "[5/5] Done."
