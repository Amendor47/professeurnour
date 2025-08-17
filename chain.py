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
