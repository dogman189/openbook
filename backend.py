# backend.py — OpenBook Flask backend (single-file, monet-style flat app).
#
# Sections: CONFIG / PATHS / STORE / INGEST / SPECS / MODELS (stub) / FLASK.
# Ported verbatim-then-Flask-ified from openbook-old backend/*.py.
#
# Heavy deps (torch/transformers/sentence_transformers/chromadb) are NEVER
# imported at top level — only lazily inside functions. The full lazy
# LLM/RAG pipeline arrives in Task 3; here model_info() is a light stub.
# Every public function stays importable with torch/chromadb uninstalled.
import json
import os
import platform
import queue
import re
import sqlite3
import sys
import time
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, request

try:
    from flask_cors import CORS
except Exception:  # flask-cors missing (unit env) — app still imports
    CORS = None

try:
    from pypdf import PdfReader
except Exception:  # pypdf missing — re-imported lazily inside parse_pdf
    PdfReader = None

try:
    import psutil
except Exception:  # optional — get_specs degrades to 0.0 ram_gb
    psutil = None


# ---------------------------------------------------------------- PATHS ----
def app_root() -> Path:
    # 1. Packaged/portable builds write next to their own data dir.
    env = os.getenv("OPENBOOK_HOME")
    if env:
        return Path(env)
    # 2. Frozen (PyInstaller build) — exe dir.
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    # 3. Dev: flat repo root is the dir holding this file.
    return Path(__file__).resolve().parent


ROOT = app_root()
DATA_DIR = ROOT / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
VECTORS_DIR = DATA_DIR / "vectors"
CHROMA_DIR = VECTORS_DIR / "chroma"
DB_PATH = ROOT / "openbook.db"
CONFIG_PATH = ROOT / "config.json"

# Embedding + LLM weights live beside the app so a portable folder stays
# self-contained and HF never writes into the user's home profile.
HF_HOME = ROOT / "models"


def ensure_dirs() -> None:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    VECTORS_DIR.mkdir(parents=True, exist_ok=True)
    HF_HOME.mkdir(parents=True, exist_ok=True)
    # Transformers reads HF_HOME at import time — set before that happens.
    os.environ.setdefault("HF_HOME", str(HF_HOME))


# No filesystem side effects at import; transformers only ever sees this
# because heavy imports happen lazily inside functions (Task 3).
os.environ.setdefault("HF_HOME", str(HF_HOME))


# --------------------------------------------------------------- CONFIG ----
def load_config() -> dict:
    # Readiness probe payload + saved renderer config. Missing/corrupt →
    # empty dict so Electron's waitForBackend still gets a 200.
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_config(data: dict) -> dict:
    # Merge posted keys over saved config and persist. Boundary-validated
    # by the route (must be a JSON object) before reaching here.
    merged = {**load_config(), **data}
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2)
    return merged


# ---------------------------------------------------------------- STORE ----
SCHEMA = """
CREATE TABLE IF NOT EXISTS notebooks(id TEXT PRIMARY KEY, title TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, notebook_id TEXT, name TEXT, type TEXT, pages INTEGER, path TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, notebook_id TEXT, role TEXT, content TEXT, citations_json TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS summaries(id TEXT PRIMARY KEY, notebook_id TEXT, source_ids_json TEXT, content TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, notebook_id TEXT, type TEXT, meta_json TEXT, created_at REAL);
"""


def _new_id() -> str:
    return str(uuid.uuid4())[:8]


def init_db(path="openbook.db"):
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def create_notebook(conn, title):
    nid = _new_id()
    conn.execute("INSERT INTO notebooks VALUES (?,?,?)", (nid, title, time.time()))
    conn.commit()
    return nid


def list_notebooks(conn):
    return [dict(r) for r in conn.execute("SELECT * FROM notebooks ORDER BY created_at DESC")]


def save_message(conn, notebook_id, role, content, citations_json="[]"):
    mid = _new_id()
    conn.execute(
        "INSERT INTO messages VALUES (?,?,?,?,?,?)",
        (mid, notebook_id, role, content, citations_json, time.time()),
    )
    conn.commit()
    return mid


def list_messages(conn, notebook_id):
    return [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM messages WHERE notebook_id=? ORDER BY created_at",
            (notebook_id,),
        )
    ]


def log_event(conn, notebook_id, type, meta_json="{}"):
    json.loads(meta_json)  # validate JSON, no PII — only ids/counters
    eid = _new_id()
    conn.execute(
        "INSERT INTO events VALUES (?,?,?,?,?)",
        (eid, notebook_id, type, meta_json, time.time()),
    )
    conn.commit()
    return eid


def save_source(conn, notebook_id, name, type, pages, path):
    sid = _new_id()
    conn.execute(
        "INSERT INTO sources VALUES (?,?,?,?,?,?,?)",
        (sid, notebook_id, name, type, pages, path, time.time()),
    )
    conn.commit()
    return sid


def list_sources(conn, notebook_id):
    return [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM sources WHERE notebook_id=? ORDER BY created_at",
            (notebook_id,),
        )
    ]


def save_summary(conn, notebook_id, source_ids_json, content):
    sid = _new_id()
    conn.execute(
        "INSERT INTO summaries VALUES (?,?,?,?,?)",
        (sid, notebook_id, source_ids_json, content, time.time()),
    )
    conn.commit()
    return sid


def list_summaries(conn, notebook_id):
    return [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM summaries WHERE notebook_id=? ORDER BY created_at DESC",
            (notebook_id,),
        )
    ]


def delete_notebook(conn, notebook_id):
    for table in ("sources", "messages", "summaries", "events"):
        conn.execute(f"DELETE FROM {table} WHERE notebook_id = ?", (notebook_id,))
    conn.execute("DELETE FROM notebooks WHERE id = ?", (notebook_id,))
    conn.commit()


# --------------------------------------------------------------- INGEST ----
MAX_BYTES = 100 * 1024 * 1024
MAX_PAGES = 1000
# Pages with less embedded text than this get raster + OCR treatment.
OCR_MIN_CHARS = 50
OCR_DPI = 200


def _pdf_reader(path):
    # pypdf resolved at call time so tests can monkeypatch backend.PdfReader
    # and the module imports fine even when pypdf is not installed.
    reader_cls = PdfReader
    if reader_cls is None:
        from pypdf import PdfReader as _PR

        reader_cls = _PR
    return reader_cls(path)


def parse_pdf(path: str):
    if os.path.getsize(path) > MAX_BYTES:
        raise ValueError("PDF over 100MB limit")
    out = []
    try:
        reader = _pdf_reader(path)
        if len(reader.pages) > MAX_PAGES:
            raise ValueError("PDF over 1000 pages limit")
        for i, p in enumerate(reader.pages, start=1):
            out.append({"page": i, "text": p.extract_text() or ""})
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"Corrupt PDF: {e}")
    total = sum(len(p["text"]) for p in out)
    if total >= 200:
        return out
    # Image-only pages: keep embedded text where it exists, OCR the rest.
    needy = [p["page"] for p in out if len(p["text"].strip()) < OCR_MIN_CHARS]
    if not needy:
        raise ValueError("Scanned PDF — extracted text too short")
    if _tesseract_cmd() is None:
        raise ValueError(
            "OCR unavailable: install Tesseract (see docs/troubleshooting.md) "
            "to ingest scanned PDFs"
        )
    try:
        for pg, png in _raster_pages(path, needy):
            out[pg - 1]["text"] = _ocr_page_png(png)
            log(f"System: OCR page {pg} done")
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"OCR failed: {e}")
    total = sum(len(p["text"]) for p in out)
    if total < 200:
        raise ValueError("Scanned PDF — text still too short after OCR")
    return out


def _tesseract_cmd():
    # Tesseract native binary resolution: explicit override first, then the
    # app-bundled copy (exe dir when packaged, repo root in dev — placed
    # there by install-deps), then anything on PATH. None means OCR is off.
    import shutil

    env = os.getenv("TESSERACT_CMD")
    if env:
        return env
    root = app_root()
    for cand in (root / "tesseract" / "tesseract.exe", root / "tesseract" / "bin" / "tesseract.exe"):
        if cand.exists():
            return str(cand)
    return shutil.which("tesseract")


def _raster_pages(path, pages):
    # PyMuPDF rasterizes without system deps (lazy import keeps it optional).
    import fitz

    doc = fitz.open(path)
    try:
        for pg in pages:
            pix = doc[pg - 1].get_pixmap(dpi=OCR_DPI)
            yield pg, pix.tobytes("png")
    finally:
        doc.close()


def _ocr_page_png(png_bytes):
    import io

    from PIL import Image

    import pytesseract

    cmd = _tesseract_cmd()
    if cmd is None:
        raise ValueError(
            "OCR unavailable: install Tesseract (see docs/troubleshooting.md) "
            "to ingest scanned PDFs"
        )
    pytesseract.pytesseract.tesseract_cmd = cmd
    img = Image.open(io.BytesIO(png_bytes))
    return pytesseract.image_to_string(img, lang="eng") or ""


def chunk_text(pages, size=800, overlap=100):
    # naive word-based chunking preserving page refs
    words = []
    for pg in pages:
        for w in pg["text"].split():
            words.append((w, pg["page"]))
    chunks, i, cid = [], 0, 0
    while i < len(words):
        sl = words[i:i+size]
        if not sl:
            break
        txt = " ".join(w for w, _ in sl)
        pgs = sorted(set(p for _, p in sl))
        chunks.append({"chunk_id": cid, "text": txt, "pages": pgs})
        cid += 1
        i += max(1, size - overlap)
    return chunks


# ---------------------------------------------------------------- SPECS ----
def get_specs() -> dict:
    # torch/psutil stay function-local so this module imports without them.
    gpu_name, vram_gb, cuda = None, 0.0, False
    try:
        import torch

        if torch.cuda.is_available() and torch.cuda.device_count() > 0:
            cuda = True
            gpu_name = torch.cuda.get_device_name(0)
            vram_gb = round(torch.cuda.get_device_properties(0).total_memory / 1e9, 1)
    except Exception:
        pass
    ram_gb = 0.0
    if psutil is not None:
        try:
            ram_gb = round(psutil.virtual_memory().total / 1e9, 1)
        except Exception:
            pass
    try:
        cpu_count = os.cpu_count() or 0
    except Exception:
        cpu_count = 0
    return {
        "gpu": gpu_name,
        "vram_gb": vram_gb,
        "cuda": cuda,
        "ram_gb": ram_gb,
        "cpu_count": cpu_count,
        "os": platform.system(),
    }


def recommend_llm(specs: dict) -> str:
    # Biggest model that comfortably fits; CPU-only stays tiny.
    if specs.get("cuda") and specs.get("vram_gb", 0) >= 20:
        return "Qwen/Qwen2.5-7B-Instruct"
    if specs.get("cuda") and specs.get("vram_gb", 0) >= 10:
        return "Qwen/Qwen2.5-3B-Instruct"
    if specs.get("cuda") and specs.get("vram_gb", 0) >= 4:
        return "Qwen/Qwen2.5-1.5B-Instruct"
    return "Qwen/Qwen3-0.6B"


# VRAM floor per preset id (fp16 + overhead; 7B relies on CPU offload).
MIN_VRAM = {
    "Qwen/Qwen3-0.6B": 2,
    "Qwen/Qwen2.5-1.5B-Instruct": 4,
    "Qwen/Qwen2.5-3B-Instruct": 7,
    "Qwen/Qwen2.5-7B-Instruct": 10,
}


def fits_model(model_id: str, specs: dict) -> dict:
    need = MIN_VRAM.get(model_id)
    if need is None:
        return {"fits": True, "reason": "Custom model — size unknown, will try to load"}
    if not specs.get("cuda"):
        ok = model_id == "Qwen/Qwen3-0.6B"
        return {
            "fits": ok,
            "reason": "No GPU — only the 0.6B model is usable on CPU"
            if not ok
            else "CPU-safe choice",
        }
    if specs.get("vram_gb", 0) >= need:
        extra = " (spills to CPU RAM if tight)" if need >= 10 else ""
        return {"fits": True, "reason": f"Needs ~{need}GB, you have {specs['vram_gb']}GB{extra}"}
    return {"fits": False, "reason": f"Needs ~{need}GB but GPU has {specs['vram_gb']}GB"}


# -------------------------------------------------------- MODELS (stub) ----
# Light stub only — no torch import. Full lazy pipeline is Task 3.
LLM_ID = os.getenv("OPENBOOK_LLM_ID", "Qwen/Qwen3-0.6B")
EMBED_ID = os.getenv("OPENBOOK_EMBED_ID", "sentence-transformers/all-MiniLM-L6-v2")

# Curated switcher presets — all fit a 12GB card (7B spills to CPU via
# accelerate's auto offload when VRAM runs out).
AVAILABLE_MODELS = [
    {"id": "Qwen/Qwen3-0.6B", "label": "Qwen 0.6B — fastest", "vram": "~2GB", "min_vram": 2},
    {"id": "Qwen/Qwen2.5-1.5B-Instruct", "label": "Qwen 1.5B — fast", "vram": "~4GB", "min_vram": 4},
    {"id": "Qwen/Qwen2.5-3B-Instruct", "label": "Qwen 3B — balanced", "vram": "~7GB", "min_vram": 7},
    {"id": "Qwen/Qwen2.5-7B-Instruct", "label": "Qwen 7B — best quality", "vram": "~9GB*", "min_vram": 10},
]


def model_info():
    return {"llm": LLM_ID, "embed": EMBED_ID, "device": _device(), "engine": "transformers"}


# ------------------------------------------- MODELS (full, lazy) ----
# Full lazy pipeline. torch/transformers/sentence_transformers import inside
# functions only — the module stays importable with all of them missing.
_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)

_llm_pipe = None
_embed_model = None


def get_llm() -> str:
    return LLM_ID


def set_llm(model_id: str) -> dict:
    # Custom HF ids allowed but must look like "org/name" — blocks path
    # traversal and URLs. Unloads the old pipeline so VRAM is freed.
    global LLM_ID, _llm_pipe
    mid = (model_id or "").strip()
    if not _ID_RE.match(mid):
        raise ValueError(f"Not a valid HuggingFace model id: {model_id!r}")
    if _llm_pipe is not None:
        _llm_pipe = None
        import gc

        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
    LLM_ID = mid
    return model_info()


def _device() -> str:
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _strip_thinking(text: str) -> str:
    # Reasoning models wrap chain-of-thought in <think> tags — never show it.
    # Also handles unclosed tags when generation stops mid-thought.
    cleaned = _THINK_RE.sub("", text)
    if re.search(r"<think>", cleaned, re.IGNORECASE):
        cleaned = re.split(r"<think>", cleaned, flags=re.IGNORECASE)[0]
    return cleaned.strip()


def _chat_wrap(prompt: str) -> str:
    # Qwen-Instruct models need their chat template — raw prompts make small
    # models ramble or continue list patterns instead of answering.
    if _llm_pipe is not None and hasattr(_llm_pipe, "tokenizer"):
        try:
            return _llm_pipe.tokenizer.apply_chat_template(
                [{"role": "user", "content": prompt}],
                tokenize=False,
                add_generation_prompt=True,
            )
        except Exception:
            pass
    return prompt


def llm_generate(prompt: str, max_new_tokens: int = 512) -> str:
    global _llm_pipe
    if _llm_pipe is None:
        from transformers import pipeline

        _llm_pipe = pipeline("text-generation", model=LLM_ID, device_map="auto")
    full_prompt = _chat_wrap(prompt)
    out = _llm_pipe(
        full_prompt,
        max_new_tokens=max_new_tokens,
        do_sample=False,
        repetition_penalty=1.15,
    )
    text = out[0]["generated_text"]
    if text.startswith(full_prompt):
        text = text[len(full_prompt):]
    return _strip_thinking(text)


def llm_stream(prompt: str, chunk: int = 120):
    full = llm_generate(prompt)
    for i in range(0, len(full), chunk):
        yield full[i:i + chunk]


def embed_texts(texts):
    global _embed_model
    if _embed_model is None:
        from sentence_transformers import SentenceTransformer

        _embed_model = SentenceTransformer(EMBED_ID, device=_device())
    vecs = _embed_model.encode([t[:4000] for t in texts], show_progress_bar=False)
    return [list(map(float, v)) for v in vecs]


# ---------------------------------------------------------------- RAG ----
_chroma_client = None


def _rag_client():
    # Lazy singleton — chromadb connects only on first vector op, so the
    # module imports and every non-RAG route works without it installed.
    global _chroma_client
    if _chroma_client is None:
        try:
            import chromadb
        except Exception as e:
            raise RuntimeError(
                "chromadb is not installed — RAG storage unavailable"
            ) from e
        ensure_dirs()
        _chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    return _chroma_client


def _col(notebook_id: str):
    return _rag_client().get_or_create_collection(f"nb_{notebook_id}")


def delete_collection(notebook_id: str):
    try:
        _rag_client().delete_collection(f"nb_{notebook_id}")
    except Exception:
        pass


def embed(texts):
    return embed_texts(texts)


def upsert(notebook_id, chunks, source=""):
    col = _col(notebook_id)
    ids = [f"{source}:{c['chunk_id']}" for c in chunks]
    vecs = embed([c["text"] for c in chunks])
    col.upsert(
        ids=ids,
        embeddings=vecs,
        documents=[c["text"] for c in chunks],
        metadatas=[
            {"pages": ",".join(map(str, c["pages"])), "source": source}
            for c in chunks
        ],
    )


def query(notebook_id, q, k=6):
    col = _col(notebook_id)
    qv = embed([q])[0]
    res = col.query(query_embeddings=[qv], n_results=k)
    return [
        {"text": doc, "pages": meta["pages"], "source": meta["source"]}
        for doc, meta in zip(res["documents"][0], res["metadatas"][0])
    ]


# --------------------------------------------------------------- CHAT ----
SYSTEM = """Answer ONLY from context. Cite every fact as [sourceName p.N].
If not in context, reply exactly: Not in your sources."""


def build_prompt(q, hits):
    ctx = "\n\n".join(f"[{h['source']} p.{h['pages']}] {h['text'][:1500]}" for h in hits)
    return f"{SYSTEM}\n\nContext:\n{ctx}\n\nQuestion: {q}"


def ask_stream(notebook_id, q):
    hits = query(notebook_id, q, k=6)
    yield from llm_stream(build_prompt(q, hits))


# ------------------------------------------------------------ SUMMARY ----
def _llm(prompt: str, max_new_tokens: int = 512) -> str:
    return llm_generate(prompt, max_new_tokens=max_new_tokens)


MAP_PROMPT = (
    "Summarize the following study material in EXACTLY 3 short bullets.\n"
    "Rules: each bullet under 20 words, plain dashes (-), no numbering, "
    "no preamble, no repeating the same phrase.\n\nMaterial:\n"
)

REDUCE_PROMPT = (
    "Combine these notes into a study guide with EXACTLY these 3 sections, "
    "using the headers shown. Keep it tight — no numbered lists past 8 items, "
    "never repeat one phrase more than twice.\n\n"
    "SUMMARY: (4-6 sentences of prose, no lists)\n"
    "KEY TERMS: (up to 8 short noun phrases, one per line starting with -)\n"
    "OUTLINE: (up to 6 short headings, one per line starting with -)\n\nNotes:\n"
)


def _parse_sections(text: str):
    # Pull the 3 labeled sections out of the reduce output. Anything the
    # model puts outside the labels is ignored so loops can't leak through.
    sections = {"SUMMARY": [], "KEY TERMS": [], "OUTLINE": []}
    current = None
    for line in text.splitlines():
        stripped = line.strip()
        # Header = name before the colon (case-insensitive) so inline
        # text after the header ("SUMMARY: prose") still matches.
        if ":" in stripped:
            head = stripped.split(":", 1)[0].strip().upper()
        else:
            head = stripped.upper()
        if head in sections:
            current = head
            rest = line.split(":", 1)[1].strip() if ":" in line else ""
            if rest:
                sections[current].append(rest)
            continue
        if current is None:
            continue
        s = line.strip()
        if not s:
            continue
        # Hard cap per section so runaway numbered lists can't leak through.
        if len(sections[current]) >= 8:
            continue
        sections[current].append(s.lstrip("-•* ").strip())
    summary = " ".join(sections["SUMMARY"])[:1500]
    key_terms = [t[:80] for t in sections["KEY TERMS"][:8] if t]
    outline = [t[:120] for t in sections["OUTLINE"][:6] if t]
    return summary, key_terms, outline


def summarize(chunks):
    bullets = []
    for c in chunks[:8]:
        bullets.append(_llm(MAP_PROMPT + c["text"][:2000], max_new_tokens=150))
    joined = "\n".join(f"- {b.strip()}" for b in bullets)[:6000]
    final = _llm(REDUCE_PROMPT + joined, max_new_tokens=600)
    summary, key_terms, outline = _parse_sections(final)
    if not summary:
        summary = final[:1500]
    if not key_terms:
        key_terms = [b.strip()[:80] for b in bullets[:5] if b.strip()]
    if not outline:
        outline = [b.strip()[:120] for b in bullets[:6] if b.strip()]
    return {"summary": summary, "key_terms": key_terms, "outline": outline}


# --------------------------------------------------------------- LOGS ----
_log_queue: "queue.Queue" = queue.Queue()


def log(message: str) -> None:
    _log_queue.put({"message": str(message), "ts": time.time()})


def _logs_generate(src=None, timeout=15):
    q = src if src is not None else _log_queue
    yield "retry: 1000\n\n"
    while True:
        try:
            yield f"data: {json.dumps(q.get(timeout=timeout))}\n\n"
        except queue.Empty:
            yield ": heartbeat\n\n"


# ---------------------------------------------------------------- FLASK ----
app = Flask(__name__)
# "null" is what a file:// page sends as Origin — the packaged app loads its
# UI over file://, so without it every request is blocked by CORS.
if CORS is not None:
    CORS(app, origins=["http://localhost:5173", "null", "*"])

_DB = None


def get_db():
    # Lazily opened so importing backend (tests, Task 3) has no
    # filesystem side effects; one connection reused per process.
    global _DB
    if _DB is None:
        ensure_dirs()
        _DB = init_db(str(DB_PATH))
    return _DB


@app.get("/api/config")
def api_get_config():
    return jsonify(load_config())


@app.post("/api/config")
def api_post_config():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "config must be a JSON object"}), 400
    return jsonify(save_config(data))


@app.get("/api/health")
def api_health():
    info = model_info()
    return jsonify({"backend": "ok", **info, "specs": get_specs()})


# ------------------------------------------------------ NOTEBOOKS API ----
@app.get("/api/notebooks")
def api_list_notebooks():
    return jsonify(list_notebooks(get_db()))


@app.post("/api/notebooks")
def api_create_notebook():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "notebook must be a JSON object"}), 400
    title = data.get("title")
    if not isinstance(title, str) or not title.strip():
        return jsonify({"error": "title required"}), 400
    nid = create_notebook(get_db(), title.strip())
    log(f'System: notebook created "{title.strip()}" ({nid})')
    return jsonify({"id": nid})


@app.delete("/api/notebooks/<nid>")
def api_delete_notebook(nid):
    import shutil

    delete_notebook(get_db(), nid)
    delete_collection(nid)
    shutil.rmtree(UPLOADS_DIR / nid, ignore_errors=True)
    log(f"System: notebook deleted {nid}")
    return jsonify({"deleted": nid})


@app.get("/api/notebooks/<nid>/sources")
def api_list_sources(nid):
    return jsonify(list_sources(get_db(), nid))


@app.post("/api/notebooks/<nid>/sources")
def api_add_source(nid):
    # Single endpoint serves both ingest paths: PDF upload (multipart file)
    # and pasted text (JSON body with `text`).
    os.makedirs(UPLOADS_DIR / nid, exist_ok=True)
    f = request.files.get("file")
    if f is not None and f.filename:
        # basename() keeps a crafted name like "../../x.pdf" from escaping
        # the uploads dir, and doubles as the display name in SQLite/Chroma.
        safe_name = os.path.basename(f.filename)
        dest = UPLOADS_DIR / nid / safe_name
        f.save(str(dest))
        try:
            pages = parse_pdf(str(dest))
        except ValueError as e:
            # >100MB / >1000 pages limits, missing-Tesseract ("OCR
            # unavailable") and unreadable-scan rejections surface here as
            # 400 with the message.
            log(f"Error: ingest rejected {safe_name}: {e}")
            return jsonify({"error": str(e)}), 400
        chunks = chunk_text(pages)
        upsert(nid, chunks, source=safe_name)
        save_source(get_db(), nid, safe_name, "pdf", len(pages), str(dest))
        log(
            f'System: source added "{safe_name}" '
            f"({len(pages)} pages, {len(chunks)} chunks)"
        )
        return jsonify(
            {"sourceId": safe_name, "pages": len(pages), "chunks": len(chunks)}
        )
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data.get("text"):
        return jsonify({"error": "text required"}), 422
    title = data.get("title") or "paste.txt"
    chunks = chunk_text([{"page": 1, "text": data["text"]}])
    upsert(nid, chunks, source=title)
    save_source(get_db(), nid, title, "text", 1, "")
    log(f'System: source added "{title}" (pasted text, {len(chunks)} chunks)')
    return jsonify({"sourceId": title, "pages": 1, "chunks": len(chunks)})


@app.get("/api/notebooks/<nid>/messages")
def api_list_messages(nid):
    return jsonify(list_messages(get_db(), nid))


@app.post("/api/notebooks/<nid>/chat")
def api_chat(nid):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "chat must be a JSON object"}), 400
    q = data.get("query")
    if not isinstance(q, str) or not q.strip():
        return jsonify({"error": "query required"}), 422
    db = get_db()
    save_message(db, nid, "user", q)
    log(f'System: ask "{q.strip()[:60]}"')
    full = []

    def gen():
        for tok in ask_stream(nid, q):
            full.append(tok)
            yield f"data: {json.dumps({'token': tok})}\n\n"
        save_message(db, nid, "assistant", "".join(full))
        log("System: answer done")
        yield "data: [DONE]\n\n"

    return Response(gen(), mimetype="text/event-stream")


@app.post("/api/notebooks/<nid>/summary")
def api_summary(nid):
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "summary must be a JSON object"}), 400
    source_ids = data.get("sourceIds") or []
    hits = query(nid, "overview of all key concepts", k=12)
    log(f"System: summary started ({len(hits)} chunks)")
    result = summarize([{"text": h["text"], "pages": [h["pages"]]} for h in hits])
    save_summary(get_db(), nid, json.dumps(source_ids), json.dumps(result))
    log("System: summary done")
    return jsonify(result)


@app.get("/api/notebooks/<nid>/summaries")
def api_list_summaries(nid):
    return jsonify(list_summaries(get_db(), nid))


@app.get("/api/models")
def api_list_models():
    specs = get_specs()
    return jsonify(
        {
            "current": get_llm(),
            "available": [
                {**m, **fits_model(m["id"], specs)} for m in AVAILABLE_MODELS
            ],
            "specs": specs,
            "recommended": recommend_llm(specs),
            "current_fit": fits_model(get_llm(), specs),
        }
    )


@app.post("/api/models")
def api_set_model():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "model must be a JSON object"}), 400
    try:
        info = set_llm(data.get("id"))
    except ValueError as e:
        log(f"Error: model switch rejected: {e}")
        return jsonify({"error": str(e)}), 422
    log(f"System: model switched to {info['llm']}")
    return jsonify(info)


@app.get("/api/logs")
def api_logs():
    return Response(_logs_generate(), mimetype="text/event-stream")


@app.post("/api/log")
def api_post_log():
    body = request.get_json(silent=True) or {}
    message = body.get("message", "") if isinstance(body, dict) else ""
    if message:
        log(message)
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    ensure_dirs()
    get_db()
    log("System: engine online | port 5678")
    app.run(host="127.0.0.1", port=5678)
