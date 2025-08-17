from __future__ import annotations
from typing import Iterable, Any, cast
from base import BaseLLMProvider

class CTransformersProvider(BaseLLMProvider):
    def __init__(self, model: str, model_file: str | None, model_type: str, config: dict):
        import os
        from ctransformers import AutoModelForCausalLM
        # Guardrails: Provide a clear error when model is not configured
        if not model or not str(model).strip():
            raise ValueError(
                "ctransformers: model_path_or_repo_id is missing. Configure it via LLM_MODEL env or config.yml -> ctransformers.model.\n"
                "Examples:\n"
                "- Local GGUF: model='/path/to/llama-2-7b.Q4_K_M.gguf', model_type='llama' (optional model_file if using a repo)\n"
                "- HF repo: model='TheBloke/llama-2-7B-GGUF', model_file='llama-2-7b.Q4_K_M.gguf', model_type='llama'"
            )
        # If model points to a local file, ensure it exists; if it's a repo, ensure model_file is provided
        if os.path.sep in model and not model.startswith(('http://','https://')):
            # Treat as local path
            if not os.path.exists(model):
                raise FileNotFoundError(
                    f"ctransformers: local GGUF not found at '{model}'. Set an absolute path to a .gguf file in config.yml -> ctransformers.model or LLM_MODEL."
                )
        else:
            # Likely a repo id; require model_file
            if not model_file:
                raise ValueError(
                    "ctransformers: when using a repo id, you must set model_file to a concrete *.gguf filename. Example: model='TheBloke/llama-2-7B-GGUF', model_file='llama-2-7b.Q4_K_M.gguf'"
                )
        # Only allow safe, supported overrides
        kwargs: dict[str, Any] = {"model": model, "model_type": model_type}
        if model_file:
            kwargs["model_file"] = model_file
        # Whitelist of supported parameters for ctransformers
        allowed = {
            "lib", "gpu_layers", "context_length", "batch_size", "threads",
            "temperature", "top_k", "top_p", "repetition_penalty",
            "last_n_tokens", "seed", "max_new_tokens"
        }
        if isinstance(config, dict):
            for k, v in config.items():
                if k in allowed:
                    kwargs[k] = v
        try:
            # Build explicit args for better type inference
            base_args = {
                "model": kwargs.pop("model"),
                "model_type": kwargs.pop("model_type"),
            }
            if "model_file" in kwargs:
                base_args["model_file"] = kwargs.pop("model_file")
            # type: ignore
            self._model = cast(Any, AutoModelForCausalLM).from_pretrained(**base_args, **kwargs)
        except Exception as e:
            hint = (
                "Hint: ensure your model_type matches the GGUF (e.g., 'llama', 'mpt', 'gpt2'), "
                "and that the file is accessible."
            )
            raise RuntimeError(f"ctransformers: failed to load model with args {kwargs!r}: {e}\n{hint}")

    def generate(self, prompt: str, **params) -> str:
        out = self._model(prompt, **params)
        try:
            # ctransformers may return a generator if stream=True was passed inadvertently
            from types import GeneratorType
            if hasattr(out, "__iter__") and not isinstance(out, (str, bytes)):
                return "".join(list(out))
        except Exception:
            pass
        return str(out)

    def stream(self, prompt: str, **params) -> Iterable[str]:
        yield from self._model(prompt, stream=True, **params)
