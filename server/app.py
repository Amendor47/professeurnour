from fastapi import FastAPI, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional, Tuple
import re, unicodedata
import os, json, uuid, sys
from collections import Counter

# Ensure project root is importable even if 'server' isn't a regular package
_HERE = os.path.dirname(__file__)
_ROOT = os.path.abspath(os.path.join(_HERE, os.pardir))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

app = FastAPI(title="Coach Local API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# --- TinyLlama default internal LLM (auto-load on startup) ---
_TINY_PATH = os.path.join(_ROOT, 'models', 'TinyLlama-1.1B-Chat-v1.0')
_ALT_TINY_PATH = os.path.join(_ROOT, 'model', 'TinyLlama-1.1B-Chat-v1.0')  # tolerate singular folder name
_TINY_FILE = 'tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf'
# Tiny defaults (kept for fallback; decoding tuned globally per route)
_TINY_CFG = {"max_new_tokens": 256, "temperature": 0.7, "top_p": 0.85, "repetition_penalty": 1.08, "context_length": 2048}
# Default internal model preference (env: INTERNAL_MODEL = tinyllama | qwen2)
INTERNAL_DEFAULT = (os.getenv('INTERNAL_MODEL', 'tinyllama') or 'tinyllama').lower()
tinyllama_model = None  # type: ignore
_TINY_GEN_KEYS = {"max_new_tokens", "temperature", "top_p", "repetition_penalty"}
try:
    from ctransformers import AutoModelForCausalLM as _CTC
    tiny_file_abs = os.path.join(_TINY_PATH, _TINY_FILE)
    use_path = _TINY_PATH
    if not os.path.exists(tiny_file_abs) and os.path.exists(os.path.join(_ALT_TINY_PATH, _TINY_FILE)):
        use_path = _ALT_TINY_PATH
        tiny_file_abs = os.path.join(use_path, _TINY_FILE)
    if os.path.exists(tiny_file_abs):
        # Pass no config object here to avoid version-specific API issues; apply generation params at call time
        tinyllama_model = _CTC.from_pretrained(use_path, model_file=_TINY_FILE, model_type='llama')  # type: ignore[arg-type]
        print(f"✅ TinyLlama chargé avec succès depuis {tiny_file_abs}")
    else:
        print(f"❌ TinyLlama non chargé (introuvable): {tiny_file_abs}")
except Exception as _e:
    tinyllama_model = None
    print("❌ Erreur chargement TinyLlama :", _e)

# --- Optional Qwen2 1.5B FR (GGUF) local model (preferred) ---
qwen_model = None  # type: ignore
_QWEN_CFG = {"max_new_tokens": 256, "temperature": 0.7, "top_p": 0.9, "repetition_penalty": 1.05, "context_length": 4096}
qwen_info: Dict[str, Any] = {"path": None, "file": None}
try:
    from ctransformers import AutoModelForCausalLM as _CTC2  # reuse if available
    # Allow explicit configuration via env vars
    _QWEN_DIR_ENV = os.getenv("QWEN_DIR")
    _QWEN_FILE_ENV = os.getenv("QWEN_FILE")
    _CANDIDATE_DIRS = []  # type: List[str]
    if _QWEN_DIR_ENV:
        _CANDIDATE_DIRS.append(os.path.expanduser(_QWEN_DIR_ENV))
    # Common local paths
    _CANDIDATE_DIRS += [
        os.path.join(_ROOT, 'models'),
        os.path.join(_ROOT, 'model'),
    ]
    chosen_dir, chosen_file = None, None
    for base in _CANDIDATE_DIRS:
        if not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            for f in files:
                name = f.lower()
                if name.endswith('.gguf') and 'qwen' in name and ('1.5' in name or '1_5' in name or '1-5' in name or '1b5' in name or '1.5b' in name):
                    # Prefer FR/instruct variants if multiple candidates
                    chosen_dir, chosen_file = root, f
                    if ('fr' in name) or ('instruct' in name):
                        break
            if chosen_file:
                break
        if chosen_file:
            break
    if _QWEN_FILE_ENV and _QWEN_DIR_ENV:
        chosen_dir, chosen_file = os.path.expanduser(_QWEN_DIR_ENV), _QWEN_FILE_ENV
    if chosen_dir and chosen_file:
        try:
            qwen_model = _CTC2.from_pretrained(chosen_dir, model_file=chosen_file, model_type='qwen2')  # type: ignore[arg-type]
            qwen_info.update({"path": chosen_dir, "file": chosen_file})
            print(f"✅ Qwen chargé avec succès depuis {os.path.join(chosen_dir, chosen_file)}")
        except Exception as _qe:
            print("❌ Erreur chargement Qwen2 :", _qe)
            qwen_model = None
    else:
        # Silent if not present; this is optional
        pass
except Exception as _qerr:
    qwen_model = None
    # Do not fail app if qwen isn't available
    print("ℹ️ Qwen2 non initialisé (optionnel) :", _qerr)

def _llm_health() -> Dict[str, Any]:
    # Inspect config to ensure local model configuration is usable
    info: Dict[str, Any] = {"ready": False, "backend": None, "issues": []}
    # If any internal model is already loaded, we are ready regardless of config
    if tinyllama_model is not None or qwen_model is not None:
        info["backend"] = "internal"
        info["model"] = "qwen2" if (qwen_model is not None) else "tinyllama"
        info["available"] = {"tinyllama": bool(tinyllama_model is not None), "qwen2": bool(qwen_model is not None)}
        info["default_model"] = ("qwen2" if qwen_model is not None else INTERNAL_DEFAULT)
        # expose discovery details for qwen
        if qwen_info.get("path") and qwen_info.get("file"):
            info["qwen"] = {"path": qwen_info.get("path"), "file": qwen_info.get("file")}
        info["ready"] = True
        return info
    try:
        from config_loader import AppConfig  # type: ignore
        cfg = AppConfig.load().data
        backend = (cfg.get('llm') or 'ctransformers')
        info['backend'] = backend
        if backend == 'ctransformers':
            ctc = (cfg.get('ctransformers') or {})
            model = (ctc.get('model') or '').strip()
            model_file = (ctc.get('model_file') or None)
            mtype = (ctc.get('model_type') or 'auto')
            if not model:
                info['issues'].append('missing_model')
            else:
                # If a local path is provided, check file/dir existence
                if ('/' in model or model.startswith('~')):
                    import os
                    path = os.path.expanduser(model)
                    if not os.path.exists(path):
                        info['issues'].append('model_path_not_found')
                # If a HF repo is specified, recommend providing model_file for GGUF repos
                if ('/' in model and not ('~' in model) and not ('/' in model and model.startswith('/')) and model.endswith('-GGUF') and not model_file):
                    info['issues'].append('missing_model_file_for_repo')
            info['ready'] = len(info['issues']) == 0
        elif backend == 'hf':
            hf = (cfg.get('huggingface') or {})
            model = (hf.get('model') or '').strip()
            if not model:
                info['issues'].append('missing_model')
            info['ready'] = len(info['issues']) == 0
        else:
            info['issues'].append('unknown_backend')
    except Exception as e:
        info['issues'].append(f'config_error: {e}')
    return info

@app.get("/health")
def health():
    return {"status": "ok", "llm": _llm_health()}

# --- Lightweight answer post-processing (first complete sentence + dedup) ---
_SENT_END_RE = re.compile(r"([\.\!\?…]+)(?=\s|$)")

def _strip_markers(s: str) -> str:
    s = s.strip()
    # remove common role prefixes
    s = re.sub(r"^(assistant|assistant:|assistant\.|réponse|reponse|réponse:|response:|utilisateur:|user:|systeme?:)\s*", "", s, flags=re.I)
    return s.strip()

def _dedup_words(s: str) -> str:
    # collapse immediate word repetitions: "droit droit droit" -> "droit"
    return re.sub(r"\b(\w+)(\s+\1\b)+", r"\1", s, flags=re.I)

def _first_sentence(s: str) -> str:
    s = s.strip()
    if not s:
        return s
    m = _SENT_END_RE.search(s)
    if m:
        end = m.end(1)
        first = s[:end].strip()
        # If too short (e.g., "Oui."), include second sentence if present
        if len(first) < 8:
            m2 = _SENT_END_RE.search(s[end:].lstrip())
            if m2:
                end2 = end + len(s[end:]) - len(s[end:].lstrip()) + m2.end(1)
                return s[:end2].strip()
        return first
    # No punctuation: return up to 200 chars at last space
    chunk = s[:200]
    last_space = chunk.rfind(' ')
    return (chunk[:last_space].strip() if last_space > 40 else chunk.strip())

def _postprocess_answer(text: str) -> str:
    t = _strip_markers(text)
    t = _dedup_words(t)
    t = re.sub(r"\s+", " ", t).strip()
    return _first_sentence(t)

def _ensure_text(x: Any) -> str:
    if isinstance(x, str):
        return x
    try:
        # For generators/iterables of strings
        return ''.join(list(x))
    except Exception:
        return str(x)

# Simple request logging middleware
@app.middleware("http")
async def log_requests(request: Request, call_next):
    # Minimal perf-friendly logging (path + method)
    _ = (request.url.path, request.method)
    response = await call_next(request)
    return response

class ExtractIn(BaseModel):
    urls: Optional[List[str]] = None
    prompt: Optional[str] = None
    schema_: Optional[Dict[str, Any]] = None
    text: Optional[str] = None
    content: Optional[str] = None

def _norm(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii","ignore").decode().lower()

@app.post("/v1/extract")
def extract(inp: ExtractIn):
    text = (inp.text or inp.content or "").strip()
    if not text:
        return {"data": {"notions_cles": [], "definitions": [], "questions": []}}

    tokens = re.findall(r"[A-Za-zÀ-ÿ]{3,}", text)
    stop = set("le la les de des du un une et ou a au aux en dans pour par avec sans sur sous entre d l que qui quoi dont est sont ete été etre être ce cet cette ces il elle nous vous on ne pas".split())
    toks = [_norm(t) for t in tokens if _norm(t) not in stop]
    cnt = Counter(toks)
    notions = [w for w,_ in cnt.most_common(12)]

    lines = [l.strip() for l in text.splitlines() if l.strip()]
    defs = []
    for l in lines:
        if re.search(r"(définition|se définit|est|consiste en)", l, re.I):
            defs.append(l[:220])
            if len(defs) >= 8:
                break

    questions = [f"Expliquez la notion: « {w} »." for w in notions[:6]]
    return {"data": {"notions_cles": notions, "definitions": defs, "questions": questions}}

# === Validation utilities (JSON schema) ===
from jsonschema import validate as _validate, ValidationError

def _extra_validate_mcq(payload: Dict[str, Any]) -> list:
    errs = []
    items = payload.get('items') or []
    if not isinstance(items, list) or not items:
        errs.append('items empty')
        return errs
    for it in items:
        opts = it.get('options') or []
        if len(opts) != 4:
            errs.append(f"{it.get('id')}: options must be 4")
        if len(set(opts)) != len(opts):
            errs.append(f"{it.get('id')}: duplicate options")
        ai = it.get('answer_index')
        if not isinstance(ai, int) or ai < 0 or ai > 3:
            errs.append(f"{it.get('id')}: answer_index out of range")
        if isinstance(ai, int) and 0 <= ai < len(opts):
            if isinstance(opts[ai], str) and re.search(r"toutes", opts[ai], re.I):
                errs.append(f"{it.get('id')}: invalid 'Toutes les réponses'")
        q = (it.get('question') or '').strip().lower()
        ans = ''
        if isinstance(ai, int) and 0 <= ai < len(opts):
            ans = (opts[ai] or '').strip().lower()
        # Leakage only if answer is substantive (>=4 chars or contains space)
        if ans and q and (len(ans) >= 4 or ' ' in ans):
            frag = ans[: min(12, len(ans))]
            if frag and frag in q:
                errs.append(f"{it.get('id')}: answer leakage in question")
        if it.get('difficulty') not in ("easy","medium","hard"):
            errs.append(f"{it.get('id')}: invalid difficulty")
        if it.get('bloom') not in ("rappel","compréhension","application","analyse"):
            errs.append(f"{it.get('id')}: invalid bloom")
    return errs

def _extra_validate_sheet(payload: Dict[str, Any]) -> list:
    errs = []
    sheets = payload.get('sheets') or []
    if not isinstance(sheets, list) or not sheets:
        errs.append('sheets empty')
        return errs
    for s in sheets:
        title = s.get('title')
        if not isinstance(title, str) or not title.strip():
            errs.append('missing title')
        sv = s.get('short_version') or {}
        mv = s.get('medium_version') or {}
        lv = s.get('long_version') or {}
        if sv.get('type') != 'bullet_points':
            errs.append(f"{title or '?'}: short_version.type must be bullet_points")
        if not isinstance(sv.get('content'), list) or not (1 <= len(sv['content']) <= 5):
            errs.append(f"{title or '?'}: short_version.content 1..5 bullets")
        if mv.get('type') != 'paragraphs':
            errs.append(f"{title or '?'}: medium_version.type must be paragraphs")
        if not isinstance(mv.get('content'), list) or not (1 <= len(mv['content']) <= 2):
            errs.append(f"{title or '?'}: medium_version.content 1..2 paragraphs")
        if lv.get('type') != 'developed' or not isinstance(lv.get('content'), str):
            errs.append(f"{title or '?'}: long_version.type must be developed with string content")
        if isinstance(lv.get('content'), str) and len(lv['content']) < 100:
            errs.append(f"{title or '?'}: long_version too short (<100 chars)")
        if not isinstance(s.get('citations'), list):
            errs.append(f"{title or '?'}: citations missing")
    return errs

@app.post("/validate/{kind}")
def validate_payload(kind: str, payload: Dict[str, Any]):
    """Validate payloads against known schemas: kind in { 'mcq', 'sheet' }"""
    here = os.path.dirname(__file__)
    root = os.path.abspath(os.path.join(here, os.pardir))
    if kind not in {"mcq","sheet"}:
        return {"ok": False, "errors": ["unknown schema kind"]}
    schema_path = os.path.join(root, "schemas", f"{kind}.schema.json")
    if not os.path.exists(schema_path):
        return {"ok": False, "errors": ["schema not found"]}
    with open(schema_path, 'r', encoding='utf-8') as f:
        schema = json.load(f)
    try:
        _validate(instance=payload, schema=schema)
        # extra rules
        extra_errors: list = []
        if kind == 'mcq':
            extra_errors = _extra_validate_mcq(payload)
        elif kind == 'sheet':
            extra_errors = _extra_validate_sheet(payload)
        if extra_errors:
            return {"ok": False, "errors": extra_errors}
        return {"ok": True, "errors": []}
    except ValidationError as e:
        return {"ok": False, "errors": [str(e)]}

# === Serve sample LLM outputs (MCQ + Sheets) ===
@app.get("/samples")
def get_samples():
    here = os.path.dirname(__file__)
    root = os.path.abspath(os.path.join(here, os.pardir))
    sample_path = os.path.join(root, "assets", "samples", "llm_samples.json")
    if not os.path.exists(sample_path):
        return {"status": "error", "error": "samples_not_found"}
    with open(sample_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data

# === Provider fallback scaffold (no external calls here, just shape) ===
class LLMRequest(BaseModel):
    task: str
    prompt: str
    provider: Optional[str] = None  # 'ctransformers' | 'hf' | 'openai' | 'auto'
    model: Optional[str] = None
    model_file: Optional[str] = None
    model_type: Optional[str] = None
    temperature: float = 0.2
    top_p: float = 0.9
    max_tokens: int = 800
    api_key: Optional[str] = None

def _run_local(req: LLMRequest) -> Tuple[str, str, Dict[str,int]]:
    """Return (provider, text, usage) using local backends if available."""
    prov = (req.provider or 'auto')
    usage = {"prompt_tokens": len(req.prompt.split()), "completion_tokens": 0}
    text = ""
    if prov in ('ctransformers','auto'):
        try:
            from ctransformers_provider import CTransformersProvider  # type: ignore
            # Load defaults from config when request fields are missing
            try:
                from config_loader import AppConfig  # type: ignore
                appcfg = AppConfig.load().data
                ctc = (appcfg.get('ctransformers') or {})
            except Exception:
                ctc = {}
            model = (req.model or ctc.get('model') or '').strip()
            model_file = req.model_file if req.model_file is not None else ctc.get('model_file')
            model_type = (req.model_type or ctc.get('model_type') or 'auto')
            cfg = {"temperature": req.temperature, **(ctc.get('config') or {})}
            p = CTransformersProvider(model=model, model_file=model_file, model_type=model_type, config=cfg)
            text = p.generate(req.prompt, max_new_tokens=req.max_tokens, temperature=req.temperature)
            return ('ctransformers', text, usage)
        except Exception as e:
            # surface actionable message when model misconfigured
            err = str(e)
            if 'missing_model' in err or 'model_path_or_repo_id' in err or 'missing' in err:
                raise
            if prov != 'auto':
                raise
    if prov in ('hf','auto'):
        try:
            from hf_provider import HFProvider  # type: ignore
            p = HFProvider(model=req.model or 'gpt2')
            text = p.generate(req.prompt, max_tokens=req.max_tokens, temperature=req.temperature)
            return ('hf', text, usage)
        except Exception:
            if prov != 'auto':
                raise
    return ('none', text, usage)

async def _run_openai(req: LLMRequest) -> Tuple[str, str, Dict[str,int]]:
    import httpx, asyncio
    if not req.api_key:
        raise ValueError('Missing OpenAI API key')
    headers = {"Authorization": f"Bearer {req.api_key}", "Content-Type": "application/json"}
    body = {
    "model": req.model or "gpt-3.5-turbo-0125",
        "messages": [
            {"role":"system","content":"Tu réponds en JSON strict conforme au schéma demandé."},
            {"role":"user","content": req.prompt }
        ],
        "temperature": req.temperature,
        "max_tokens": req.max_tokens
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post("https://api.openai.com/v1/chat/completions", headers=headers, json=body)
        r.raise_for_status()
        data = r.json()
        text = (data.get('choices') or [{}])[0].get('message',{}).get('content','')
        usage = data.get('usage', {}) or {"prompt_tokens": 0, "completion_tokens": 0}
        return ('openai', text, usage)

def _log_run(task: str, provider: str, ok: bool, ms: int, usage: Dict[str,int]):
    runs_dir = os.path.join(os.path.dirname(__file__), 'db', 'runs')
    os.makedirs(runs_dir, exist_ok=True)
    path = os.path.join(runs_dir, 'runs.jsonl')
    rec = {"task": task, "provider": provider, "ok": ok, "ms": ms, **{f"usage_{k}": v for k,v in (usage or {}).items()}}
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")

@app.post("/llm/run")
async def llm_run(req: LLMRequest):
    import time
    t0 = time.time()
    provider = req.provider or 'auto'
    text, used_provider, usage = '', 'none', {"prompt_tokens": len(req.prompt.split()), "completion_tokens": 0}
    try:
        if provider in ('openai',):
            used_provider, text, usage = await _run_openai(req)
        else:
            used_provider, text, usage = _run_local(req)
            if used_provider == 'none' and provider in ('auto',):
                # fallback to OpenAI only if api_key provided
                if req.api_key:
                    used_provider, text, usage = await _run_openai(req)
        ok = True
        return {"provider": used_provider, "status": "ok", "usage": usage, "output": text}
    except Exception as e:
        ok = False
        return {"provider": used_provider, "status": "error", "error": str(e), "usage": usage, "output": ""}
    finally:
        ms = int((time.time()-t0)*1000)
        _log_run(req.task, used_provider, ok, ms, usage)

# === Minimal chat/generate endpoints for front-end compatibility ===
class ChatIn(BaseModel):
    messages: List[Dict[str, str]]
    provider: Optional[str] = None
    model: Optional[str] = None
    model_file: Optional[str] = None
    model_type: Optional[str] = None
    api_key: Optional[str] = None

class GenerateIn(BaseModel):
    prompt: str
    provider: Optional[str] = None
    model: Optional[str] = None
    model_file: Optional[str] = None
    model_type: Optional[str] = None
    api_key: Optional[str] = None

@app.post("/chat")
async def chat(inp: ChatIn, request: Request):
    # Compose prompt from chat messages
    prompt = "\n".join([f"{m.get('role','user')}: {m.get('content','')}" for m in (inp.messages or [])])
    # allow Authorization header for API key
    auth = request.headers.get('Authorization') or ''
    api_key = inp.api_key or (auth.split('Bearer ',-1)[-1] if 'Bearer ' in auth else '')
    req = LLMRequest(task='chat', prompt=prompt, provider=inp.provider or 'auto', model=inp.model, model_file=inp.model_file, model_type=inp.model_type, api_key=api_key)
    try:
        used_provider, text, usage = _run_local(req)
        if used_provider == 'none' and api_key:
            used_provider, text, usage = await _run_openai(req)
        # Lightweight post-processing for chat outputs only
        text = _postprocess_answer(_ensure_text(text))
        ok = True
        return {"status": "ok", "provider": used_provider, "output": text, "usage": usage}
    except Exception as e:
        return {"status": "error", "error": str(e), "provider": 'none', "output": ""}

@app.post("/generate")
async def generate(inp: GenerateIn, request: Request):
    auth = request.headers.get('Authorization') or ''
    api_key = inp.api_key or (auth.split('Bearer ',-1)[-1] if 'Bearer ' in auth else '')
    req = LLMRequest(task='generate', prompt=inp.prompt, provider=inp.provider or 'auto', model=inp.model, model_file=inp.model_file, model_type=inp.model_type, api_key=api_key)
    try:
        used_provider, text, usage = _run_local(req)
        if used_provider == 'none' and api_key:
            used_provider, text, usage = await _run_openai(req)
        return {"status": "ok", "provider": used_provider, "output": text, "usage": usage}
    except Exception as e:
        return {"status": "error", "error": str(e), "provider": 'none', "output": ""}

# --- Minimal API chat endpoint that strictly uses the internal TinyLlama ---
@app.post("/api/chat")
async def api_chat(request: Request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    # Accept either a direct prompt or a messages[] list
    prompt = (data.get("prompt") or "").strip()
    if not prompt and isinstance(data.get("messages"), list):
        try:
            msgs = data.get("messages") or []
            prompt = "\n".join([f"{m.get('role','user')}: {m.get('content','')}" for m in msgs])
        except Exception:
            prompt = ""
    course_context = (data.get("context") or "").strip()
    # Strict grounding: refuse to answer without explicit course context
    if not course_context:
        return {"reply": "Je n’ai pas trouvé cela dans le cours.", "model": ("qwen2" if qwen_model is not None else ("tinyllama" if tinyllama_model is not None else None))}
    task = str(data.get("task") or "chat").lower()
    out_format = str(data.get("format") or "text").lower()
    # Apply a concise French instruction to stabilize output
    system = (
        "Tu es Professeur Nour, un coach d’étude bienveillant. Réponds en français clair, structuré et concis (phrases simples). "
        "Tu t'appuies UNIQUEMENT sur le cours fourni dans le contexte. Si l'information n'est pas dans le cours, réponds: \"Je n’ai pas trouvé cela dans le cours.\" "
        "Si la question est floue, demande une précision. N'invente rien (surtout pas d'articles)."
    )
    context_block = (f"\n\n=== CONTEXTE DU COURS ===\n{course_context}" if course_context else "")
    header = f"{system}{context_block}\n\n=== QUESTION DE L'ÉTUDIANT ===\n{prompt}\n\n"
    if out_format == 'json' or 'mcq' in task:
        full_prompt = f"{header}=== RÉPONSE ATTENDUE (JSON STRICT) ===\n"
    else:
        full_prompt = f"{header}=== RÉPONSE DU PROFESSEUR NOUR ===\n"
    provider = str(data.get("provider") or "internal").lower()
    # Allow explicit local model selection via body.model: "qwen2" or "tinyllama"
    # Prefer Qwen2 by default when available
    preferred_model = str(data.get("model") or ("qwen2" if qwen_model is not None else INTERNAL_DEFAULT) or "tinyllama").lower()
    if provider in {"internal", "ctransformers", "local"}:
        # Choose model respecting explicit selection when provided
        model_obj = None
        gen_kwargs: Dict[str, Any] = {}
        if preferred_model.startswith("qwen") and qwen_model is not None:
            model_obj = qwen_model
            gen_kwargs = {k: v for k, v in _QWEN_CFG.items() if k in _TINY_GEN_KEYS}
        elif preferred_model.startswith("tiny") and tinyllama_model is not None:
            model_obj = tinyllama_model
            gen_kwargs = {k: v for k, v in _TINY_CFG.items() if k in _TINY_GEN_KEYS}
        else:
            # Fallback preference: Qwen if available, else TinyLlama
            if qwen_model is not None:
                model_obj = qwen_model
                gen_kwargs = {k: v for k, v in _QWEN_CFG.items() if k in _TINY_GEN_KEYS}
            elif tinyllama_model is not None:
                model_obj = tinyllama_model
                gen_kwargs = {k: v for k, v in _TINY_CFG.items() if k in _TINY_GEN_KEYS}
        if model_obj is None:
            return {"error": "⚠️ IA interne indisponible"}
        try:
            raw = model_obj(full_prompt, **gen_kwargs)
            text = _ensure_text(raw)
            # Skip post-processing if expecting JSON/MCQ to avoid corrupting the structure
            reply = text if (out_format == 'json' or 'mcq' in task) else _postprocess_answer(text)
            return {"reply": reply, "model": ("qwen2" if model_obj is qwen_model else "tinyllama")}
        except Exception as e:
            return {"error": f"⚠️ IA interne indisponible: {e}"}
    # Pas de fallback OpenAI sur cette route
    return {"error": "⚠️ IA interne indisponible"}

# --- Firecrawl lightweight proxy (health + chat passthrough/placeholder) ---
@app.get("/firecrawl/health")
def firecrawl_health():
    # Healthy if API key is present in env or not strictly required
    ok = bool(os.getenv('FIRECRAWL_API_KEY'))
    return {"ok": ok}

class FCChatIn(BaseModel):
    messages: List[Dict[str,str]]
    api_key: Optional[str] = None

@app.post("/firecrawl/chat")
async def firecrawl_chat(inp: FCChatIn, request: Request):
    # If a key is provided, reuse OpenAI runner as a chat proxy (pragmatic fallback)
    last = (inp.messages or [])[-1:] or []
    q = (last[0].get('content') if last else '') or ''
    if inp.api_key or request.headers.get('Authorization','').startswith('Bearer '):
        key = inp.api_key or request.headers.get('Authorization','')[7:]
        req = LLMRequest(task='chat', prompt=f"user: {q}", provider='openai', api_key=key)
        try:
            _, text, usage = await _run_openai(req)
            return {"status":"ok","answer": text, "usage": usage}
        except Exception as e:
            return {"status":"error","error": str(e), "answer": ""}
    # No API key: return a helpful message instead of empty
    return {"status":"ok","answer":"Firecrawl n'est pas configuré localement. Ajoutez une clé (ou utilisez OpenAI) pour des réponses générées."}

# === RAG helpers (chunking + overlap + naive rerank) ===
def _split_tokens(text: str, size: int=550, overlap: int=100) -> List[str]:
    words = text.split()
    chunks = []
    i = 0
    while i < len(words):
        chunk = words[i:i+size]
        if not chunk: break
        chunks.append(' '.join(chunk))
        i += size - overlap
    return chunks

def _score(query: str, passage: str) -> float:
    q = set(re.findall(r"\w+", query.lower()))
    p = set(re.findall(r"\w+", passage.lower()))
    inter = len(q & p); uni = len(q | p) or 1
    return inter/uni

def _retrieve(query: str, corpus: List[Dict[str,str]], k: int=8) -> List[Dict[str,str]]:
    scored = [ (doc, _score(query, doc.get('text',''))) for doc in corpus ]
    scored.sort(key=lambda x: x[1], reverse=True)
    return [x[0] for x in scored[:k]]

@app.post("/rag/retrieve")
def rag_retrieve(body: Dict[str, Any]):
    text = (body.get('text') or '').strip()
    query = (body.get('query') or '').strip()
    k = int(body.get('k') or 8)
    size = int(body.get('chunk_size') or 550)
    overlap = int(body.get('overlap') or 100)
    if not text:
        return {"passages": []}
    chunks = _split_tokens(text, size=size, overlap=overlap)
    corpus = [{"id": f"p{i}", "text": c} for i,c in enumerate(chunks)]
    hits = _retrieve(query or text[:300], corpus, k=k)
    return {"passages": hits}

# === Publish & Serve Study Sheets ===
STORAGE_DIR = os.path.join(os.path.dirname(__file__), 'db', 'sheets')
os.makedirs(STORAGE_DIR, exist_ok=True)

class SheetCard(BaseModel):
    title: str
    summary: Optional[str] = None
    full: Optional[str] = None

class SheetPayload(BaseModel):
    title: Optional[str] = "Fiches"
    sheets: List[SheetCard]

@app.post("/sheets")
def publish_sheets(payload: SheetPayload):
    sid = uuid.uuid4().hex[:10]
    data = payload.dict()
    path = os.path.join(STORAGE_DIR, f"{sid}.json")
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return {"id": sid, "url": f"/sheets/{sid}", "api": f"/api/sheets/{sid}"}

@app.get("/api/sheets/{sid}")
def get_sheets_json(sid: str):
    path = os.path.join(STORAGE_DIR, f"{sid}.json")
    if not os.path.exists(path):
        return {"error": "not_found"}
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)

@app.get("/sheets/{sid}")
def get_sheets_html(sid: str):
    path = os.path.join(STORAGE_DIR, f"{sid}.json")
    if not os.path.exists(path):
        return Response("<h1>404</h1><p>Fiches introuvables.</p>", media_type='text/html', status_code=404)
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    title = (data.get('title') or 'Fiches')
    cards = data.get('sheets') or []
    # Minimal embedded CSS for portability
    css = """
    body{font-family:Inter,Segoe UI,system-ui,-apple-system,Arial,sans-serif;background:#f6f7fb;color:#1f2937;margin:0}
    .container{max-width:900px;margin:20px auto;padding:16px}
    h1{font-size:22px}
    .card{background:#fff;border:1px solid #e5e7f2;border-radius:14px;box-shadow:0 6px 20px rgba(20,30,58,.08);padding:14px 16px;margin:12px 0}
    .card h3{margin:0 0 8px 0}
    .meta{opacity:.7;margin-top:6px}
    """
    html_cards = []
    for c in cards:
        h = f"""
        <article class=card>
          <h3>{(c.get('title') or '').replace('<','&lt;')}</h3>
          <p>{(c.get('summary') or '').replace('\n','<br>').replace('<','&lt;')}</p>
          {f"<details><summary>Voir plus</summary><div>{(c.get('full') or '').replace('<','&lt;').replace('\n','<br>')}</div></details>" if c.get('full') else ''}
        </article>
        """
        html_cards.append(h)
    doc = f"""
    <!doctype html><html lang=fr><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
    <title>{title}</title><style>{css}</style></head><body>
      <div class=container>
        <h1>{title}</h1>
        {''.join(html_cards)}
      </div>
    </body></html>
    """
    return Response(doc, media_type='text/html')