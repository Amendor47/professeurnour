# Professeur Nour UI notes

Images used (drop them into `assets/`):

- `nour-avatar.png` — header brand avatar (square/portrait).
- `nour-badge.png` — round badge used in chat bubbles and FAB icon.
- `nour-waving.png` — waving pose used for bottom-right nudge “Le professeur est là pour t'aider !”.
- `nour-pointing.png` — pointing pose used in the chat window header.

All image tags include onerror SVG fallbacks so the UI stays clean even if files are missing.
# finalcoach

## Themes

- Default: `theme-nour` (dark). Also available: `theme-studycave`.
- Light mode has been removed on request. The UI always uses dark tokens.
- Switch from Paramètres → "Thème visuel". The choice persists in `localStorage.selected-theme`.

## Quick start

Prereqs: macOS, zsh, Python 3.10+.

1) Put TinyLlama model file here (either path is accepted):

- `models/TinyLlama-1.1B-Chat-v1.0/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf`
- or `model/TinyLlama-1.1B-Chat-v1.0/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf`

Optionally, you can also place a local Qwen2 1.5B FR GGUF (if available). The server will auto-detect common filenames under `models/` or `model/`. When present, Qwen2 is preferred by default and reported by `/health` (see field `default_model`). You can force a specific path via env:

```
export QWEN_DIR=/absolute/path/to/models/Qwen2-1_5B
export QWEN_FILE=qwen2-1_5b-instruct-fr-q4_k_m.gguf
```

To quickly test Qwen2 outside the server, run the smoke script:

```
python3 scripts/test_qwen.py /path/to/your_course.txt
```

2) Start everything automatically:

```
make run
```

This will create `.venv`, install deps, start the API on 127.0.0.1:8000, wait for `/health`, and open `coach.html`.

3) Test the internal chat API (context-grounded):

```
curl -s -X POST http://127.0.0.1:8000/api/chat -H 'Content-Type: application/json' -d '{
	"prompt":"Peux-tu me résumer les causes principales ?",
	"context":"Cours d’histoire : La Révolution française a été provoquée par la crise financière..."
}'
```

Notes:

- The `/api/chat` route never falls back to OpenAI. Use provider “OpenAI” in the UI if you want that.
- `/health` returns `{ ready: true }` when an internal model is loaded at startup, with fields `available`, `default_model`, and (when found) `qwen.path`/`qwen.file`.
- Server-side post-processing trims duplication and keeps only the first sentence for normal chat; it is disabled automatically when `format:"json"` or `task:"mcq"` is used.
- Qwen2 is preferred automatically when present. To force TinyLlama:

```
export INTERNAL_MODEL=tinyllama
```

4) MCQ JSON mode (optional)

You can ask the internal API to return JSON instead of free text:

```
curl -s -X POST http://127.0.0.1:8000/api/chat -H 'Content-Type: application/json' -d '{
	"task":"mcq",
	"format":"json",
	"prompt":"Génère 3 QCM sur les causes de la Révolution française.",
	"context":"La Révolution française a été provoquée par la crise financière..."
}'
```

	Strict grounding: if you don't pass a `context`, the API answers with the fixed sentence:

	`Je n’ai pas trouvé cela dans le cours.`

Optional: accept PDF as input for the Qwen2 local test

If you want to use a PDF for the smoke test, install a lightweight reader and pipe the extracted text:

```
python3 -m pip install --quiet pdfminer.six
python3 - <<'PY'
from pdfminer.high_level import extract_text
import sys
print(extract_text(sys.argv[1]))
PY your_course.pdf > /tmp/course.txt
python3 scripts/test_qwen.py /tmp/course.txt
```