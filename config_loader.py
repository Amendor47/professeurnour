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
