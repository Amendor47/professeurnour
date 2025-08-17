from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Iterable

class BaseLLMProvider(ABC):
    @abstractmethod
    def generate(self, prompt: str, **params) -> str: ...
    @abstractmethod
    def stream(self, prompt: str, **params) -> Iterable[str]: ...
