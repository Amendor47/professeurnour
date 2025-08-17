#!/usr/bin/env python3
import os
import sys
import re

try:
    from ctransformers import AutoModelForCausalLM
except Exception as e:
    print("[ERROR] ctransformers not installed in this environment.")
    print("Install with: pip install ctransformers")
    sys.exit(1)

QWEN_DIR = os.getenv("QWEN_DIR")
QWEN_FILE = os.getenv("QWEN_FILE")
if not QWEN_DIR or not QWEN_FILE:
    print("[ERROR] Please set QWEN_DIR and QWEN_FILE environment variables.")
    print("Example:")
    print("  export QWEN_DIR=/absolute/path/to/models/Qwen2-1_5B")
    print("  export QWEN_FILE=qwen2-1_5b-instruct-fr-q4_k_m.gguf")
    sys.exit(2)

model_path = os.path.join(os.path.expanduser(QWEN_DIR), QWEN_FILE)
if not os.path.exists(model_path):
    print(f"[ERROR] GGUF file not found: {model_path}")
    sys.exit(3)

print("⚙️ Chargement du modèle Qwen2...")
model = AutoModelForCausalLM.from_pretrained(
    os.path.expanduser(QWEN_DIR),
    model_file=QWEN_FILE,
    model_type="qwen2",
)
print("✅ Modèle Qwen2 chargé avec succès !\n")

prompt = (
    "Tu es Professeur Nour, pédagogue et concis. Réponds en français clair avec des phrases simples.\n"
    "Utilisateur:\nBonjour, peux-tu me résumer la Révolution française en 3 phrases ?\n\nRéponse:"
)

# Lightweight post-processing
SENT_END_RE = re.compile(r"([\.\!\?…]+)(?=\s|$)")

def first_sentence(s: str) -> str:
    s = s.strip()
    m = SENT_END_RE.search(s)
    if m:
        end = m.end(1)
        first = s[:end].strip()
        if len(first) < 8:
            m2 = SENT_END_RE.search(s[end:].lstrip())
            if m2:
                end2 = end + len(s[end:]) - len(s[end:].lstrip()) + m2.end(1)
                return s[:end2].strip()
        return first
    parts = s.split(" ")
    return " ".join(parts[:40])

print("⏳ Inférence…")
text = model(prompt, max_new_tokens=180, temperature=0.2, top_p=0.85, repetition_penalty=1.07)
print("\n🤖 Réponse Qwen2 (brute):\n", text)
try:
    cleaned = first_sentence(re.sub(r"\s+", " ", str(text)).strip())
    print("\n✨ Réponse (post-traitée):\n", cleaned)
except Exception:
    pass
