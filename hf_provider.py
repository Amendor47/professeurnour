from __future__ import annotations
from typing import Iterable, Optional
from base import BaseLLMProvider

class HFProvider(BaseLLMProvider):
    def __init__(self, model: str, device: Optional[int] = None):
        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch  # noqa: F401
        if not model or not str(model).strip():
            raise ValueError("huggingface: model repo is missing. Configure config.yml -> huggingface.model or set LLM_MODEL.")
        try:
            self.tok = AutoTokenizer.from_pretrained(model, use_fast=True)
            device_map = "auto" if device is not None else None
            self.model = AutoModelForCausalLM.from_pretrained(model, torch_dtype="auto", device_map=device_map)
        except Exception as e:
            raise RuntimeError(f"huggingface: unable to load model '{model}'. Ensure it is downloadable or cached. Error: {e}")

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
