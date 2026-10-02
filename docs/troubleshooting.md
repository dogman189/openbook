# OpenBook Troubleshooting v1

All local — check in this order: models → backend → frontend → data. `GET /api/health` tells you which layer is broken (`device`, `llm`, `specs`).

## Study engine off / models downloading
**Symptom:** Banner "Study engine is off" / first Ask or Summary hangs.
**Fix:** No Ollama — models load via transformers on first AI call and download weights into `models/` (several GB depending on preset; the 1.5B preset pulls ~3–5GB with dependencies). Watch progress in the Studio log panel (`GET /api/logs` stream). Check:
```bash
.venv\Scripts\activate
python -c "import backend; print(backend.model_info())"
curl http://127.0.0.1:5678/api/models
```
If the card says it doesn't fit (e.g. `Needs ~4GB but GPU has ...`), pick a smaller Qwen preset or override before launch with `OPENBOOK_LLM_ID=Qwen/Qwen3-0.6B` (the default — the only CPU-safe choice). Custom ids must look like `org/name` or `POST /api/models` returns 422.

## Torch has no GPU / too slow on CPU
**Symptom:** `/api/health` shows `"device": "cpu"` on a machine with an NVIDIA GPU, or inference crawls.
**Fix:** `requirements.txt` pins the CUDA 12.6 wheel (`--extra-index-url https://download.pytorch.org/whl/cu126`, `torch==2.14.0+cu126`, ~4.2GB). Reinstall it with an NVIDIA driver + CUDA-capable GPU and `device` flips to `cuda`. No NVIDIA GPU? Edit `requirements.txt` first and replace `torch==2.14.0+cu126` with `torch==2.14.0` for the ~200MB CPU-only wheel (slower, but works anywhere), then re-run `install-deps.bat` / `pip install -r requirements.txt`.

## OpenRouter cloud asks fail
**Symptom:** Ask returns `Error: OpenRouter: …` in chat.
**Fix by message:**
- `invalid API key` → re-paste the key in Studio → Engine (keys start `sk-or-`). Env override: `OPENROUTER_API_KEY`.
- `out of credits` → top up at openrouter.ai. Check spend per request in the response `usage.cost` via `GET /api/v1/generation` if needed.
- `rate limited` → wait and retry; pick a smaller model.
- `key missing` → no key saved and no env var set. Cloud is opt-in; Local keeps working with no key at all.
**Privacy:** cloud mode sends the retrieved notebook chunks to OpenRouter. The key itself never leaves `config.json` on this laptop (`GET /api/config` only reports `openrouter_key_set`).

## Backend won't start / port 5678 busy
**Symptom:** `curl http://127.0.0.1:5678/api/config` fails, or Electron shows the missing-dependencies box.
**Fix:** Backend binds fixed `127.0.0.1:5678` — there is no port flag. If busy, find and kill the stale Python:
```bash
netstat -ano | findstr 5678
taskkill /PID <pid> /F
```
If modules are missing (`Could not find Python` / `dependencies missing` dialog): the setup screen's Install button fetches Python 3.11 itself via the bundled `bin/uv.exe` — no python.org visit needed. Manual fallback (system Python 3.11+ only): create the venv the finder probes (`venv/` or `.venv/` — either works) and install:
```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```
`flask-cors` is optional (app imports without it, but the `file://` UI needs it for the `null`-origin requests); `pypdf` is required for PDF ingest; `chromadb` only for Ask/Summary vectors.

## Frontend blank / CORS
**Symptom:** Window opens blank, console CORS error.
**Fix:** The UI loads over `file://`, so it sends `Origin: null` — `backend.py` allows `["http://localhost:5173", "null", "*"]` (only when `flask-cors` is installed; without it every request is blocked). Start the backend first (`npm start` does it for you — Electron polls `GET /api/config` 30×500ms before showing the window). Never convert `renderer.js` to `type=module`: file:// module CORS fails, which is why the renderer is a classic script on `window.APP_CONFIG.backendUrl`.

## PDF rejected
- **Too big:** `PDF over 100MB limit` → split by chapters.
- **Too long:** `PDF over 1000 pages limit` → split by chapters.
- **Scanned, engine missing:** `OCR unavailable: install Python dependencies ...` → run `pip install -r requirements.txt` (or the in-app **Install dependencies** button) and re-upload. Pages with embedded text are kept; only image-only pages are rastered at 200 DPI.
- **Scanned, still unreadable:** `Scanned PDF — OCR found no readable text` → higher-resolution scan, or Paste text.
- **Corrupt:** `Corrupt PDF: ...` → re-export. The uploaded file stays in `data/uploads/<notebook>/`; nothing is quarantined away.
- **Missing text field:** `text required` (422) → JSON body must include `text`.

## OCR setup (scanned PDFs)
OCR is [EasyOCR](https://github.com/JaidedAI/EasyOCR), a pure-Python dependency — no native binary, no separate installer. Image-only pages are OCRed per page at 200 DPI; pages that already have a text layer are left untouched.
- **Install:** `pip install -r requirements.txt` (or the in-app **Install dependencies** button). Without it, uploads of scans return the `OCR unavailable` 400; everything else still works.
- **Models:** the detector/recogniser weights (~100MB) download once on first OCR into `data/easyocr/`, so a portable folder stays self-contained. Watch progress in the Activity Log.
- **Speed:** GPU is used when torch reports CUDA, CPU otherwise (slower — seconds per page). Large scans take minutes; other requests keep working.
- **Quality:** best on clean, straight, high-contrast scans. Handwriting, skew, and low-DPI phone photos are where accuracy drops.

## Chroma lock / no results
**Symptom:** Chroma lock error on Ask/Summary, or `Not in your sources.` for everything.
**Fix:** Stop the backend (quit Electron — `before-quit` kills Python; also kill stale `python` PIDs on 5678), delete the lock inside `data/vectors/chroma/`, restart, re-upload. Check the upload response's `chunks` count — 0 chunks = parse failed. Note the index is per-notebook (`nb_<id>` collections); deleting a notebook deletes its collection, so re-uploads start clean.

## History lost
Messages live in `openbook.db` (`messages` table) + `GET /api/notebooks/<id>/messages`. If empty after restart, the DB path is wrong — it must be `openbook.db` next to `backend.py` (or under `$OPENBOOK_HOME` in portable builds), not in `data/`. `data/` + `*.db` + `models/` are gitignored by design.

## Windows venv paths
`main.js` probes `<venvBase>/.venv` then `<venvBase>/venv` (`Scripts/python.exe` on Windows, `bin/python` elsewhere), falling back to system `python`/`python3`/`py`. `<venvBase>` is the repo root in dev but `%APPDATA%/OpenBook` when packaged — the portable exe extracts to a fresh Temp dir per launch, so an exe-side venv would evaporate (and native DLL loads from Temp trip AV rules). `install-deps.bat` creates a folder-local `.venv` instead; both locations are found. If Electron says dependencies are missing, activate whichever exists and `pip install -r requirements.txt` (note: PowerShell activation is `.venv\Scripts\Activate.ps1`).

## Ports quick check
```bash
curl http://127.0.0.1:5678/api/config
curl http://127.0.0.1:5678/api/health
npm start
```
First two must be ok for Ask + Summary to work offline. Port is always 5678 — there is no `:8000` or `:11434` anymore; Ollama is gone.
