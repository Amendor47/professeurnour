#!/usr/bin/env python3
import os
import sys
from pathlib import Path

# Optional: allow llama_cpp or ctransformers depending on what's installed
try:
    from llama_cpp import Llama  # type: ignore
    BACKEND = 'llama_cpp'
except Exception:
    Llama = None  # type: ignore
    BACKEND = None
try:
    from ctransformers import AutoModelForCausalLM, AutoConfig  # type: ignore
    BACKEND = BACKEND or 'ctransformers'
except Exception:
    AutoModelForCausalLM = None  # type: ignore


def err(msg: str, code: int = 1):
    print(f"❌ {msg}")
    sys.exit(code)


if len(sys.argv) < 2:
    err("Glisse-dépose un fichier de cours sur le script, ex: python3 scripts/test_qwen.py ~/cours.txt")

cours_path = Path(sys.argv[1]).expanduser()
if not cours_path.exists():
    err(f"Fichier introuvable: {cours_path}")

# --- Read course content (txt/markdown); note: PDF requires extra deps (see README)
try:
    with cours_path.open('r', encoding='utf-8') as f:
        cours = f.read()
except UnicodeDecodeError:
    # Fallback latin-1
    with cours_path.open('r', encoding='latin-1', errors='ignore') as f:
        cours = f.read()
except Exception as e:
    err(f"Impossible de lire le fichier {cours_path}: {e}")

print("⚙️ Chargement du modèle Qwen2…")

qwen_dir = os.getenv('QWEN_DIR') or ''
qwen_file = os.getenv('QWEN_FILE') or ''
if not qwen_dir or not qwen_file:
    err("Variables d'environnement QWEN_DIR et QWEN_FILE requises (voir README).")
model_path = str(Path(str(qwen_dir)) / str(qwen_file))
if not Path(model_path).exists():
    err(f"Fichier modèle introuvable: {model_path}")

# --- Build message list with strict grounding
messages = [
    {"role": "system", "content": (
        "Tu es Professeur Nour, pédagogue et concis. "
        "Tu dois TOUJOURS répondre uniquement à partir du cours fourni. "
        "Si l'information n'est pas présente, réponds: \"Je n’ai pas trouvé cela dans le cours.\""
    )},
    {"role": "user", "content": f"Voici le cours:\n{cours}\n\nExplique-moi ce chapitre de manière simple et claire."}
]

response_text = None

try:
    if BACKEND == 'llama_cpp' and Llama is not None:
        llm = Llama(
            model_path=model_path,
            n_ctx=4096,
            n_threads=int(os.getenv('QWEN_THREADS', '4')),
            temperature=0.7,
            max_tokens=256,
        )
        out = llm.create_chat_completion(messages=messages)
        response_text = out["choices"][0]["message"]["content"].strip()
    elif BACKEND == 'ctransformers' and AutoModelForCausalLM is not None:
        cfg = AutoConfig.from_pretrained(model_path, context_length=4096)
        llm = AutoModelForCausalLM.from_pretrained(model_path, model_type='qwen2', config=cfg)
        # Simple prompt composition for ctransformers
        prompt = (messages[0]["content"] + "\n\n" + messages[1]["content"])[:8000]
        response_text = llm(prompt, temperature=0.7, max_new_tokens=256)
    else:
        err("Aucun backend LLM local disponible (installe llama-cpp-python ou ctransformers).")
except Exception as e:
    err(f"Erreur d'inférence: {e}")

print("✅ Modèle Qwen2 testé avec succès !\n")
print("🤖 Réponse Qwen2 :\n")
print(response_text or "(vide)")
