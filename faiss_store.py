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
