# OpenBook on Monet Architecture — Design Spec
Date: 2026-09-27 | Target: `E:\projects\openbook` | Sources: `E:\projects\openbook-old` + `E:\python\monet`
Status: Approved design (Sections 1-3) — pending spec review before `writing-plans`

## 1. Intent & Understanding

**Outcome:** Copy OpenBook study-app functionality from `openbook-old` into empty `E:\projects\openbook`, using monet's cleaner flat architecture.

**Who / why:** Solo dev wants monet's maintainability (flat root, CJS `main.js` + `preload.js`, `pyinstaller --onefile`, `install.sh/ps1` + `build.sh/ps1`, explicit `package.json` build block) without losing OpenBook behavior: notebooks with isolated sources, cited streaming answers, summaries, persisted history, 100% local.

**What was said vs assumptions:**
- Said: "copy over openbook-old but use cleaner architecture of monet" → clarified to full monet-style rewrite (single Flask file, OpenBook features with monet look, monet ports/packaging).
- Assumed (confirmed): target is greenfield (`E:\projects\openbook` holds only `.opencode/`), so no in-place migration; old `backend/` + `frontend/` nesting is dropped.

**Success criteria:** `npm start` launches Electron → Flask on 5678 → new notebook "Bio 101" → add 2 PDFs → ask "Explain mitosis checkpoints simply?" → streamed answer with `[lec1.pdf p.3]` → summary + key terms + outline → history persists after restart. `pytest tests/ -v` + `node scripts/check.mjs` pass.

## 2. Architecture & Layout (A+B Hybrid)

Flat root — no `backend/` or `frontend/` subfolders:

```
E:\projects\openbook\
  main.js            # CJS, from monet, adapted (port 5678, 1280x860, OPENBOOK_HOME)
  preload.js         # APP_CONFIG bridge { backendUrl: http://127.0.0.1:5678 }
  backend.py         # single Flask file (sections below)
  index.html         # monet shell hosting Notebook/Sources/Chat/Studio
  renderer.js        # BASE from APP_CONFIG, boot/waitForBackend/SSE/poll
  app.css            # monet tokens/orbs/panels adapted for study UX
  macos.css          # copied for hiddenInset traffic lights (optional)
  requirements.txt   # openbook heavies + flask/flask-cors, minus fastapi/uvicorn
  package.json       # monet build block adapted (appId dev.openbook.app)
  backend.spec       # pyinstaller --onefile backend.py -w
  build.sh / build.ps1
  install.sh / install.ps1
  install-deps.bat   # Windows venv fallback from openbook-old
  scripts/check.mjs  # ported asset/JS check, flattened
  tests/             # ported pytest (store/ingest/rag/chat/summary)
  docs/api-reference.md + troubleshooting.md (updated to /api/* 5678)
  data/ (gitignored) # sqlite/chroma/uploads/models under OPENBOOK_HOME
```

**WHY flat + single file:** Matches monet's proven shape (smallest file count, explicit packaged files, `extraResources backend.exe`). Keeps Electron/Python contract obvious: spawn → poll `/api/config` → show window.

**WHY A+B (not pure A):** Pure onefile with `torch==2.14.0+cu126 + transformers + chromadb` yields 3-5GB `backend.exe` and slow builds. V1 ships electron-builder `dir` + `.venv` fallback (like openbook-old `_bundle`), defers onefile to V2 after size validation. Lazy model imports keep startup fast.

**Electron flow:** `findBackendExecutable()` → packaged `resources/backend(.exe)` or dev `venv/.venv Scripts/python + backend.py` or system `python/python3/py` → `spawn` with `cwd=userData (packaged) or __dirname (dev)` → `waitForBackend(30x500ms on GET /api/config)` → `createWindow()` with `preload`, `contextIsolation:true`, `nodeIntegration:false`. Native menu (File/Edit/View/Window + mac About). `before-quit/will-quit` kills Python. External links via `shell.openExternal`.

## 3. Components & API Mapping

### 3.1 backend.py sections (Flask-ified verbatim logic)

- **CONFIG/STATE:** `OPENBOOK_HOME` env (packaged `userData`/exe dir, dev repo root), `ensure_dirs()`, `DB_PATH/UPLOADS_DIR/CHROMA_DIR/MODELS_DIR`, `OPENBOOK_LLM_ID` override, Flask + `flask-cors` (allow `null` origin for `file://`).
- **STORE (sqlite):** `init_db`, `create/list/delete_notebook`, `save/list_sources`, `save/list_messages`, `save/list_summaries` — same schema as `store.py` (`openbook.db`).
- **INGEST:** `parse_pdf` (100MB / 1000 pages limits, scanned `<200 chars` → `ValueError("OCR not in v1")`), `chunk_text` — same as `ingest.py`.
- **RAG:** `upsert/query/delete_collection` per notebook via Chroma, `k=12` for summary — same as `rag.py`.
- **MODELS (lazy):** `AVAILABLE_MODELS`, `get_llm/set_llm`, `model_info`, `fits_model/recommend_llm` — `torch/transformers/sentence_transformers` imported inside functions on first `/api/health` or chat/summary call, not at top-level.
- **CHAT:** `ask_stream(nid, query)` cited tokens `[source p.X]`; unknown → `"Not in your sources — try rephrasing, or add another lecture file."`
- **SUMMARY:** map-reduce top-12 chunks → `{summary, keyTerms, outline}` (~20s offline).

### 3.2 API (port 5678, all `/api/*`)

```
GET  /api/config                    # readiness probe + saved config
POST /api/config                    # save config JSON
GET  /api/health                    # {backend:ok, model, specs}
GET  /api/models                    # {current, available, specs, recommended, current_fit}
POST /api/models                    # {id} → set_llm, 422 on bad id
GET  /api/notebooks                 # list
POST /api/notebooks                 # {title} → {id}
DELETE /api/notebooks/<nid>         # + rag.delete_collection + rmtree uploads/<nid>
GET  /api/notebooks/<nid>/sources   # list
POST /api/notebooks/<nid>/sources   # multipart file OR JSON {text,title} → {sourceId,pages,chunks}
GET  /api/notebooks/<nid>/messages  # history
POST /api/notebooks/<nid>/chat      # {query} SSE: data: {"token":...} ... data: [DONE]
POST /api/notebooks/<nid>/summary   # {sourceIds?} → {summary,keyTerms,outline}
GET  /api/notebooks/<nid>/summaries # list
GET  /api/logs                      # SSE: retry:1000 + data: "<ts msg>" + :heartbeat
POST /api/log                       # {message} → {status:ok}
```

**Example — chat SSE:**
```bash
curl -N -X POST http://127.0.0.1:5678/api/notebooks/abc/chat \
  -H "Content-Type: application/json" -d '{"query":"What triggers anaphase?"}'
# data: {"token":"The spindle "}
# data: {"token":"checkpoint [lec1.pdf p.3]"}
# data: [DONE]
```

**Example — sources:**
```bash
# PDF
curl -X POST http://127.0.0.1:5678/api/notebooks/abc/sources -F file=@lec1.pdf
# → {"sourceId":"lec1.pdf","pages":12,"chunks":48}
# Paste
curl -X POST http://127.0.0.1:5678/api/notebooks/abc/sources \
  -H "Content-Type: application/json" -d '{"text":"Mitosis...","title":"paste.txt"}'
```

Old bare paths (`/health`, `/notebooks`) are dropped; renderer uses `/api/*` only.

### 3.3 Frontend

- `index.html`: monet shell (orbs, `#topbar` wordmark OpenBook + `algo-chip`, `#status-pill`, `#theme-toggle`, left rail `#notebooks` + `#sources-slot`, center `#center-slot` chat + citations, right `Studio` `#studio-slot` summary). Trading canvas/chart/`currency.js`/`nav.js`/`model.html`/`trade.html` dropped (YAGNI). CSP: `connect-src http://127.0.0.1:5678`.
- `renderer.js`: `BASE=APP_CONFIG.backendUrl`, `boot()=waitForBackend(/api/config,50x400ms)→loadConfig→startLogStream(EventSource /api/logs)→setInterval(sync,2200)`, `sync` renders notebooks/sources/chat/summary, `lockInputs` while streaming, `esc()` for log HTML.
- `preload.js`: `contextBridge.exposeInMainWorld('APP_CONFIG',{backendUrl, platform})` + `is-mac` class pre-render.
- Classic `<script src>` (not `type=module`) — ES modules blocked over `file://`.

## 4. Data Flows

1. **Boot:** Electron `startPythonBackend()` → Flask `load_config()` → `log("engine online | port 5678")` → Electron `waitForBackend` → `createWindow` → `loadFile index.html`.
2. **Ask:** renderer `POST /api/notebooks/<id>/chat` → `save_message(user)` → Flask `Response(gen())` streams `data: {token}` → renderer appends + renders `[source p.X]` clickable → on `[DONE]` `save_message(assistant)`.
3. **Ingest:** drag PDF → `POST sources` multipart → `basename()` safe name → `parse_pdf` → `chunk_text` → `rag.upsert` + `store.save_source` → left rail updates.
4. **Summary:** `POST summary` → `rag.query("overview of all key concepts",k=12)` → `summarize()` → `save_summary` → Studio pane.
5. **Logs:** Flask `log_queue` → `GET /api/logs` SSE → renderer `appendLog` (500-row cap, classes buy/sell→cite/sys/sig/risk/filter reused as cite/sys/err).

## 5. Error Handling

- Python not found → `showErrorBox("Python Not Found")` + quit.
- Missing modules preflight (`flask, chromadb, pypdf`) → `showErrorBox` listing modules + `install-deps.bat` / `pip install -r requirements.txt` hint (no dead window).
- Backend dies during probe → log + still show window with banner + retry button.
- Port 5678 busy / Chroma lock → `/api/health {degraded}` + banner ("kill stale python, delete chroma lock").
- Qwen 3-5GB first-run download → `#boot-sub` progress via `/api/logs`, `OPENBOOK_LLM_ID` override + `specs.fits_model` GPU check.
- Ingest errors → 400 for `>100MB/>1000ppg/OCR-not-in-v1`, 422 `text required` for empty paste.
- Chat unknown → friendly not-in-sources message (not empty stream).

## 6. Testing & Checks

- `npm start` (dev smoke), `pytest tests/ -v` (ported store/ingest/rag/chat/summary + Flask client for `/api/*`), `node scripts/check.mjs` (parse every JS, verify `index.html` refs).
- Manual gate: Bio 101 → 2 PDFs → cited ask → summary → restart persists (`openbook.db` + Chroma under `OPENBOOK_HOME`).
- Dropped: `openbook-backend.spec` dir-bundle spec replaced by root `backend.spec` onefile (V2); `stage-backend/postbuild` folded into `build.sh/ps1`.

## 7. Rollout

- **Phase 1 (now):** flat copy + Flask port + `dir` packaging + `.venv` fallback. Usable without solving torch-bundling.
- **Phase 2:** `pyinstaller --onefile backend.py -w` → `dist/backend(.exe)` → `extraResources` portable (win) / AppImage (linux) / mac arm64, after measuring exe size + cold start.
- **Non-goals:** OCR, cloud/telemetry (local `events` off by default), multi-window, trading code (`llm-engine.js`, `currency.js`, `nav.js`, `crypto-prices/model/trade/settings.html`).

## 8. Open Decisions for Plan Phase

- Exact `AVAILABLE_MODELS` list + default Qwen ID for `requirements.txt` CUDA pin.
- `app.css` token mapping (keep monet cyan/violet dark glass vs openbook `#f2f4f9` light default + dark toggle).
- `check.mjs` flattened path list for new root.
