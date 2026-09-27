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
import sqlite3
import sys
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, request

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
    reader = _pdf_reader(path)
    if len(reader.pages) > MAX_PAGES:
        raise ValueError("PDF over 1000 pages limit")
    out = []
    try:
        for i, p in enumerate(reader.pages, start=1):
            out.append({"page": i, "text": p.extract_text() or ""})
    except Exception as e:
        raise ValueError(f"Corrupt PDF: {e}")
    total = sum(len(p["text"]) for p in out)
    if total < 200:
        raise ValueError("Scanned PDF — OCR not in v1: extracted text too short")
    return out


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
    return {"llm": LLM_ID, "embed": EMBED_ID, "device": "cpu", "engine": "transformers"}


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


if __name__ == "__main__":
    ensure_dirs()
    get_db()
    app.run(host="127.0.0.1", port=5678)
