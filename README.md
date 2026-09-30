# OpenBook
Ask your lecture notes anything. Private, offline, cited.

Drop in PDFs → Ask → get answers with `[source p.N]` + one-click study guides. Your notes never leave this laptop.

## Features
- Notebooks with own Sources (PDFs + pasted text)
- Ask with streaming answers + clickable citations
- Summary with key terms + outline per Notebook
- Saved history per Notebook, persists across restarts
- Model picker (Qwen 0.6B → 7B) with GPU-fit check per card
- Live backend log stream in the Studio panel
- 100% local: single-file Flask backend + Electron + transformers (Qwen), no API keys

## Stack
Electron shell (CommonJS, no bundler — the UI loads over `file://`, so `type=module` is forbidden), plain-JS renderer driven by `window.APP_CONFIG.backendUrl`, single-file Python/Flask backend (`backend.py`), Chroma for vectors, SQLite (`openbook.db`) for notebooks/history, transformers + Qwen for the LLM.

WHY this stack: Python for PDF/RAG control, Electron for double-click study UX, transformers + Qwen for a zero-cost private LLM. Heavy deps (torch/transformers/sentence-transformers/chromadb) are imported lazily inside functions, so the backend starts fast and every non-AI route works without them installed. Trade-off: first Ask/Summary call downloads model weights into `models/`.

## Installation
Prereqs: Node 20+ (only to run Electron). No system Python needed — the app
ships `bin/uv.exe`, which fetches its own Python 3.11 on first install.

```bash
install-deps.bat   # Windows: uv bootstraps Python + .venv + libraries
npm install
```

Dev without the app (system Python 3.11+ only):

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
npm install
```

WHY `.venv`: the packaged app and `install-deps.bat` both use `.venv`; dev `main.js` also accepts `venv`. No Ollama — models load via transformers on first use. GPU? The pinned `torch==2.14.0+cu126` needs an NVIDIA GPU + CUDA; CPU-only machines should swap in `torch==2.14.0` (~200MB vs ~4.2GB) before installing.

## Quick Start
```bash
npm start
```
That launches Electron, which spawns the Python backend for you and polls `GET /api/config` until it answers. Then:
New notebook "Bio 101" → Add 2 PDFs → Ask "Explain mitosis checkpoints simply?" → Generate summary.

Expected: streamed answer with `[lec1.pdf p.3]`-style cites, summary + key terms + outline, history persists after restart (SQLite + `GET /api/notebooks/<id>/messages`).

## Portable build (Windows, Phase 1)
```bash
npm run pack
```
Output: `release/win-unpacked/`. Copy the whole folder anywhere, then `OpenBook.exe`. On first launch the setup screen installs everything itself (uv fetches Python 3.11, creates `.venv`, installs libraries) — or run `install-deps.bat` beforehand. Everything the app creates (`openbook.db`, `config.json`, `data/`, `models/`) stays inside that folder via `OPENBOOK_HOME`. See `SETUP.txt`.

WHY dir-pack + `.venv` fallback (not onefile): bundling `torch + transformers + chromadb` into a single `backend.exe` yields a 3–5GB binary with slow builds. V1 ships `electron-builder --win --x64 --dir` + `.venv` fallback; onefile (`backend.spec` + `build.ps1`/`build.sh`) is deferred to Phase 2 after size validation.

## Checks
```bash
python -m pytest tests/ -v   # 56 tests: store/ingest/rag/chat/summary + Flask /api/* client
node scripts/check.mjs       # parses backend URL wiring + every index.html slot + renderer contract
node scripts/check-main.mjs  # loads main.js under a stubbed Electron and drives the real setup IPC handlers
```

## Usage
- **Notebooks:** Create one per class/exam. Each has isolated Sources + history. Deleting one also deletes its vector collection and `data/uploads/<id>/` folder.
- **Sources:** Upload PDFs (limit 100MB / 1000 pages) or paste text. Scanned PDFs get per-page OCR via EasyOCR (embedded text kept, image-only pages rastered at 200 DPI) — install it with `pip install -r requirements.txt`, see `docs/troubleshooting.md#ocr-setup-scanned-pdfs`.
- **Ask:** Only answers from your Sources (top-6 chunks). Unknown → the model replies exactly `Not in your sources.`
- **Summary:** Queries top-12 chunks, maps the first 8 into bullets, reduces to SUMMARY + KEY TERMS + OUTLINE. Takes ~20s+ offline on first run (model download).
- **Models:** Studio model picker lists 4 Qwen presets with per-card fit (`fits` + `reason`) from `/api/models`, a recommended pick for your GPU, and `OPENBOOK_LLM_ID` override. The Studio Engine section switches to OpenRouter cloud models (opt-in; key stays on this laptop, notebook content leaves it) — see `docs/api-reference.md` (`POST /api/engine`).

## API Reference
See `docs/api-reference.md` for the full contract. Core (all under `http://127.0.0.1:5678`):
- `GET /api/config` → readiness probe + saved config (Electron polls this)
- `GET /api/health` → backend + model engine status + machine specs
- `POST /api/notebooks` → create Notebook (`{title}` → `{id}`)
- `POST /api/notebooks/<id>/sources` → upload PDF (multipart) or paste text (JSON)
- `POST /api/notebooks/<id>/chat` (SSE) → Ask stream ending in `data: [DONE]`
- `POST /api/notebooks/<id>/summary` → `{summary, key_terms, outline}`
- `GET /api/logs` (SSE) → live backend log stream for the Studio panel

Error shape is always `{error: "<message>"}`: `400` = malformed request or PDF limit, `422` = well-formed but missing/invalid field (`text required`, `query required`, bad model id).

## Troubleshooting
See `docs/troubleshooting.md` — model download, torch/CUDA, port 5678 busy, Chroma lock, Windows venv paths.

## Contributing
Phases in `docs/superpowers/plans/2026-09-27-openbook-monet-rewrite.md`. Backend first, then Electron. Run `python -m pytest tests/ -v` + `node scripts/check.mjs` before PR. Keep the flat root: one `backend.py`, one `renderer.js`, no new top-level dirs without a plan update.

## License
Local-use v1 — no cloud, no telemetry. `POST /api/log` writes to a local in-memory stream only; notebooks/history stay in `openbook.db`.
