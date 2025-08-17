#!/bin/zsh
# One-click launcher for Professeur Nour (macOS)
# - Creates a venv (repo root)
# - Installs deps (server + root requirements if present)
# - Starts FastAPI on 127.0.0.1:8000 (background)
# - Waits for /health
# - Opens coach.html

set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$SELF_DIR/server"
VENV="$SELF_DIR/.venv"
# Prefer python from venv; fall back to python3 if needed
PY="$VENV/bin/python"
if [ ! -x "$PY" ] && [ -x "$VENV/bin/python3" ]; then PY="$VENV/bin/python3"; fi
PIP="$VENV/bin/pip"
LOG="$SERVER_DIR/server.log"
PID="$SERVER_DIR/.uvicorn.pid"
HOST=127.0.0.1
PORT=8000

say_ok(){ echo "[Coach] $1"; }
say_err(){ echo "[Coach][ERREUR] $1" >&2; }

say_ok "Préparation de l'environnement…"
command -v python3 >/dev/null || { say_err "python3 introuvable"; exit 1; }
[ -x "$PY" ] || python3 -m venv "$VENV"
"$PIP" install --upgrade pip >/dev/null
if [ -f "$SERVER_DIR/requirements.txt" ]; then "$PIP" install -r "$SERVER_DIR/requirements.txt" >/dev/null; fi
if [ -f "$SELF_DIR/requirements.txt" ]; then "$PIP" install -r "$SELF_DIR/requirements.txt" >/dev/null || true; fi

# Vérifier/installer le modèle interne (TinyLlama)
MODEL_DIR_A="$SELF_DIR/models/TinyLlama-1.1B-Chat-v1.0"
MODEL_DIR_B="$SELF_DIR/model/TinyLlama-1.1B-Chat-v1.0"
MODEL_FILE="tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"
MODEL_A="$MODEL_DIR_A/$MODEL_FILE"
MODEL_B="$MODEL_DIR_B/$MODEL_FILE"
if [ -f "$MODEL_A" ] || [ -f "$MODEL_B" ]; then
  say_ok "Modèle TinyLlama détecté."
else
  say_err "Modèle TinyLlama introuvable. Tentative de téléchargement…"
  DEST_DIR="$MODEL_DIR_A"
  mkdir -p "$DEST_DIR"
  URL="https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/$MODEL_FILE?download=true"
  if command -v curl >/dev/null 2>&1; then
    curl -L --retry 3 --retry-delay 2 -o "$DEST_DIR/$MODEL_FILE" "$URL" || true
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$DEST_DIR/$MODEL_FILE" "$URL" || true
  fi
  if [ -f "$DEST_DIR/$MODEL_FILE" ] && [ $(stat -f%z "$DEST_DIR/$MODEL_FILE" 2>/dev/null || echo 0) -gt 5000000 ]; then
    say_ok "Modèle TinyLlama téléchargé."
  else
    say_err "Téléchargement du modèle TinyLlama échoué. L'IA interne pourra être indisponible."
  fi
fi

# Nettoyage PID éventuel
if [ -f "$PID" ] && ! ps -p "$(cat "$PID" 2>/dev/null)" >/dev/null 2>&1; then
  rm -f "$PID"
fi

# Libérer le port 8000 si occupé par une instance précédente (optionnel)
if lsof -iTCP:${PORT} -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  say_ok "Le port ${PORT} est occupé — tentative d'arrêt de l'instance existante…"
  PIDS=( $(lsof -tiTCP:${PORT} -sTCP:LISTEN) )
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
  sleep 1
fi

cd "$SELF_DIR"
if [ -f "$PID" ] && ps -p "$(cat "$PID" 2>/dev/null)" >/dev/null 2>&1; then
  say_ok "Serveur déjà actif (PID $(cat "$PID"))."
else
  : > "$LOG"
  say_ok "Démarrage du serveur (http://${HOST}:${PORT})…"
  nohup "$PY" -m uvicorn server.app:app --host "$HOST" --port "$PORT" >>"$LOG" 2>&1 &
  echo $! > "$PID"
fi

# Attendre que /health soit OK (jusqu'à ~10s)
say_ok "Attente du démarrage du backend…"
READY=0
for i in {1..40}; do
  if curl -sSf "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
    # Vérifie que l'IA interne est prête (llm.ready=true)
    RDY="$($PY - <<'PY'
import json,sys,urllib.request
try:
    with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=1.5) as r:
        d=json.load(r)
    print("1" if (d.get("llm",{}).get("ready") is True) else "0")
except Exception:
    print("0")
PY
)"
    if [ "$RDY" = "1" ]; then
      READY=1
      say_ok "Backend prêt (IA interne initialisée)."
      break
    else
      say_ok "Backend actif — initialisation de l'IA en cours…"
    fi
  fi
  sleep 0.5
done
if [ "$READY" != "1" ]; then
  say_err "L'IA interne n'est pas encore prête. L'interface va s'ouvrir, mais certaines fonctions peuvent être indisponibles pendant quelques secondes."
fi

say_ok "Ouverture de l'interface…"
open "$SELF_DIR/coach.html"
say_ok "Prêt."
