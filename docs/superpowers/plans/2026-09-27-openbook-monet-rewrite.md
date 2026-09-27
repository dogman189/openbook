# OpenBook Monet Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild OpenBook as flat monet-style app in `E:\projects\openbook` with single Flask `backend.py`.

**Architecture:** Electron CJS `main.js` spawns Flask on 5678, polls `GET /api/config`, shows monet-shell `index.html`; `renderer.js` uses `APP_CONFIG.backendUrl` + SSE. Backend sections ported verbatim then Flask-ified, heavy ML lazy-loaded, Phase 1 dir-packaging.

**Tech Stack:** Electron 30+, Python 3.11+ Flask + flask-cors, Chroma 0.5.5, pypdf 4.2.0, torch cu126 + transformers 4.48.3 + sentence-transformers 3.4.1 (lazy), SQLite3 stdlib, plain JS (no bundler, classic scripts).

**Spec:** `docs/superpowers/specs/2026-09-27-openbook-monet-rewrite-design.md`

## Global Constraints

- Port is `5678` (`http://127.0.0.1:5678`), all JSON under `/api/*` — old bare `/health` dropped.
- Backend is single `backend.py` Flask (not FastAPI/uvicorn); SSE via `flask.Response(mimetype="text/event-stream")`.
- Flat root: no `backend/` or `frontend/` folders; `main.js` CJS with `require`, not ESM `import`.
- Renderer uses only `window.APP_CONFIG.backendUrl`, `contextIsolation:true`, `nodeIntegration:false`, classic `<script src>` (no `type=module` over `file://`).
- CORS must allow `null` origin for `file://` + `http://localhost:*`.
- Data root is `OPENBOOK_HOME` env or exe dir (packaged) or repo root (dev); `openbook.db`, `data/uploads/<nid>/`, `data/vectors/chroma`, `models/` live there.
- `torch/transformers/sentence_transformers` lazy-imported inside functions, never top-level.
- Ingest limits: `MAX_BYTES=100*1024*1024`, `MAX_PAGES=1000`, `<200 chars` → `ValueError("Scanned PDF — OCR not in v1...")`.
- Chat unknown → exactly `Not in your sources` semantics; citations `[source p.N]`.
- Phase 1 ships `electron-builder --win --x64 --dir` + `.venv` fallback; onefile `backend.exe` deferred to Phase 2.

## Review Focus

- Stale Chroma lock after kill → expect banner with delete-lock fix, not dead window.
- Port 5678 busy (zombie backend) → expect `/api/health {degraded}` + retry, not silent hang.
- 3GB Qwen first download → expect `#boot-sub` progress via `/api/logs`, not frozen boot.
- Crafted filename `../../x.pdf` upload → expect `basename()` containment in `uploads/<nid>/`.
- Scanned PDF pasted-text empty → expect 400/422 with actionable copy, not empty stream.

---

### Task 1: Electron shell + packaging scaffold

**Files:**
- Create: `main.js`, `preload.js`, `package.json`, `backend.spec`, `build.sh`, `build.ps1`, `install.sh`, `install.ps1`, `install-deps.bat`
- Test: `scripts/check.mjs` (create minimal in this task, extend in Task 4)

**Interfaces:**
- Consumes: none (first task)
- Produces: `findBackendExecutable() -> {exe,args}|null`, `waitForBackend(retries,delay)->Promise`, `APP_CONFIG={backendUrl,platform}`, npm scripts `start/build`, build files list for Task 4-5

- [ ] **Step 1: Write the failing check — backend URL wiring**

```js
// scripts/check.mjs must fail until preload + main exist
import fs from "fs";
const pre = fs.readFileSync("preload.js","utf8");
if (!pre.includes("http://127.0.0.1:5678")) throw new Error("backendUrl 5678 missing");
const main = fs.readFileSync("main.js","utf8");
if (!main.includes("/api/config")) throw new Error("readiness probe missing");
if (!main.includes("process.resourcesPath")) throw new Error("packaged exe lookup missing");
```

- [ ] **Step 2: Run check to verify it fails**

Run: `node scripts/check.mjs`
Expected: FAIL with file-not-found or "backendUrl 5678 missing"

- [ ] **Step 3: Implement `main.js` (CJS) in `main.js`**

Copy `E:\python\monet\main.js`, change `BACKEND_PORT=5678` kept, window `1280x860`, `backgroundColor "#f2f4f9"`, add `shell.openExternal` handler + `OPENBOOK_HOME: DATA_ROOT` env in `spawn()` + preflight for `flask, chromadb, pypdf`.

- [ ] **Step 4: Implement `preload.js`, `package.json`, `backend.spec`, install/build scripts**

`preload.js`: `exposeInMainWorld('APP_CONFIG',{backendUrl:'http://127.0.0.1:5678',platform})` + `is-mac` class. `package.json`: name `openbook`, main `main.js`, scripts `start: electron .`, `check: node scripts/check.mjs`, `pack: electron-builder --win --x64 --dir`, build `appId dev.openbook.app, productName OpenBook, files=[main.js,preload.js,index.html,renderer.js,app.css,macos.css,package.json], asar:false, win dir x64`. `backend.spec`: `Analysis(['backend.py']) → EXE onefile -w name backend`. `build.sh/ps1`: `pip install pyinstaller; pyinstaller --onefile backend.py -w; npm run build`. `install.sh/ps1` + `install-deps.bat`: venv + `pip install -r requirements.txt`.

- [ ] **Step 5: Run check to verify it passes**

Run: `node scripts/check.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add main.js preload.js package.json backend.spec build.sh build.ps1 install.sh install.ps1 install-deps.bat scripts/check.mjs
git commit -m "feat: add monet-style electron shell and packaging"
```

### Task 2: Flask core — paths/store/ingest/specs + config/health

**Files:**
- Create: `backend.py`, `requirements.txt`
- Test: `tests/test_store.py`, `tests/test_ingest.py`, `tests/test_specs.py`, `tests/test_api_core.py`

**Interfaces:**
- Consumes: Task 1 `waitForBackend GET /api/config`
- Produces: `init_db(path)->conn`, `create_notebook(conn,title)->nid`, `list_notebooks(conn)->rows`, `save_message/list_messages`, `save_source/list_sources`, `save_summary/list_summaries`, `delete_notebook(conn,nid)`, `parse_pdf(path)->[{page,text}]`, `chunk_text(pages,size=800,overlap=100)->[{chunk_id,text,pages}]`, `get_specs()->dict`, `recommend_llm(specs)->id`, `fits_model(id,specs)->{fits,reason}`, Flask `GET/POST /api/config`, `GET /api/health`

- [ ] **Step 1: Write failing tests for store + ingest + specs**

```python
def test_create_and_list_notebook(tmp_path):
    from backend import init_db, create_notebook, list_notebooks
    conn = init_db(str(tmp_path/"t.db"))
    nid = create_notebook(conn, "Bio 101")
    assert any(r["id"]==nid for r in list_notebooks(conn))

def test_parse_pdf_limits_reject(tmp_path):
    from backend import parse_pdf
    import pytest
    p = tmp_path/"big.pdf"; p.write_bytes(b"x"*(100*1024*1024+1))
    with pytest.raises(ValueError, match="100MB"): parse_pdf(str(p))

def test_recommend_cpu_only():
    from backend import recommend_llm
    assert recommend_llm({"cuda":False})=="Qwen/Qwen3-0.6B"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_store.py tests/test_ingest.py tests/test_specs.py -v`
Expected: FAIL with "backend not defined / No module named backend"

- [ ] **Step 3: Implement `backend.py` sections CONFIG/PATHS/STORE/INGEST/SPECS + Flask `/api/config` + `/api/health` in `backend.py`**

Port `paths.py` (`app_root()->OPENBOOK_HOME|frozen|repo-root`, `ROOT/DATA_DIR/UPLOADS_DIR/VECTORS_DIR/CHROMA_DIR/DB_PATH/HF_HOME`, `ensure_dirs()`), `store.py` verbatim (ids `uuid[:8]`), `ingest.py` verbatim, `specs.py` verbatim (lazy `torch/psutil` inside `get_specs`). Flask: `CORS(app, origins=["http://localhost:5173","null","*"])`, `GET /api/config→saved json`, `POST /api/config→save`, `GET /api/health→{backend:ok,**model_info(),specs}` with lazy model import. `requirements.txt`: `flask>=3.0 flask-cors pypdf==4.2.0 chromadb==0.5.5 torch==2.14.0+cu126 transformers==4.48.3 accelerate==1.2.1 sentence-transformers==3.4.1 pytest httpx psutil` + cu126 extra-index.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_store.py tests/test_ingest.py tests/test_specs.py tests/test_api_core.py -v`
Expected: PASS (mock heavy imports via monkeypatch where needed)

- [ ] **Step 5: Commit**

```bash
git add backend.py requirements.txt tests/test_store.py tests/test_ingest.py tests/test_specs.py tests/test_api_core.py
git commit -m "feat: add flask core with store ingest specs and health"
```

### Task 3: RAG + models lazy + chat/summary/sources APIs

**Files:**
- Modify: `backend.py` (append RAG/MODELS/CHAT/SUMMARY + routes)
- Test: `tests/test_rag.py`, `tests/test_chat.py`, `tests/test_summary.py`, `tests/test_models.py`, `tests/test_api.py`

**Interfaces:**
- Consumes: Task 2 `init_db`, `chunk_text`, `get_specs`
- Produces: `embed_texts(texts)->vectors`, `upsert(nid,chunks,source)`, `query(nid,q,k=6)->[{text,pages,source}]`, `delete_collection(nid)`, `get_llm()->id`, `set_llm(id)->info`, `llm_generate(prompt,max_new_tokens)->str`, `llm_stream(prompt,chunk=120)->iter`, `build_prompt(q,hits)->str`, `ask_stream(nid,q)->iter`, `summarize(chunks)->{summary,key_terms,outline}`, routes `GET/POST /api/notebooks*`, `POST sources`, `POST chat SSE`, `POST summary`, `GET/POST /api/models`, `GET /api/logs SSE`

- [ ] **Step 1: Write failing tests for RAG/chat/summary/models APIs**

```python
def test_chat_build_prompt_cites():
    from backend import build_prompt
    p = build_prompt("Q", [{"source":"lec1.pdf","pages":"3","text":"spindle"}])
    assert "[lec1.pdf p.3]" in p and "ONLY from context" in p

def test_sources_rejects_scanned(monkeypatch, tmp_path):
    from backend import parse_pdf
    import pytest
    f = tmp_path/"s.pdf"; f.write_bytes(b"%PDF tiny")
    monkeypatch.setattr("backend.PdfReader", lambda p: type("R",(),{"pages":[type("P",(),{"extract_text":lambda s:"x"})()]})())
    with pytest.raises(ValueError, match="OCR not in v1"): parse_pdf(str(f))

def test_chat_sse_done(client):
    r = client.post("/api/notebooks/abc/chat", json={"query":"hi"})
    assert b"[DONE]" in r.data
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_rag.py tests/test_chat.py tests/test_summary.py tests/test_models.py tests/test_api.py -v`
Expected: FAIL with missing `build_prompt/ask_stream/summarize` or route 404

- [ ] **Step 3: Implement RAG/MODELS/CHAT/SUMMARY + routes in `backend.py`**

Port `rag.py` (`PersistentClient(CHROMA_DIR)`, `_col nb_<id>`, `upsert ids={source}:{chunk_id}`, `query k` default 6), `models.py` with lazy imports + `AVAILABLE_MODELS` 4 Qwen presets + `_ID_RE ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` + `_strip_thinking` + `_chat_wrap`, `chat.py` (`SYSTEM Answer ONLY...`, `build_prompt`, `ask_stream k=6`), `summary.py` (`MAP_PROMPT 3 bullets<20w`, `REDUCE_PROMPT SUMMARY/KEY TERMS/OUTLINE`, `_parse_sections` caps 8/6). Routes: notebooks CRUD + `DELETE` also `delete_collection + rmtree uploads/<nid>`, `POST sources` (multipart `file` with `basename()` guard else JSON `{text,title}` → 422 `text required`), `POST chat` SSE `data: {"token"}` + save user/assistant messages, `POST summary` (`query k=12` → `summarize`), `GET messages/summaries`, `GET/POST /api/models` (422 on bad id), `GET /api/logs` SSE + `POST /api/log`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/ -v`
Expected: PASS (stub `llm_generate/embed_texts` in unit tests, no GPU needed)

- [ ] **Step 5: Commit**

```bash
git add backend.py tests/test_rag.py tests/test_chat.py tests/test_summary.py tests/test_models.py tests/test_api.py
git commit -m "feat: add rag chat summary and notebook apis"
```

### Task 4: Monet-shell frontend (index/renderer/css)

**Files:**
- Create: `index.html`, `renderer.js`, `app.css`, `macos.css`
- Modify: `scripts/check.mjs`, `package.json` (files list)
- Test: `scripts/check.mjs` extended + manual smoke

**Interfaces:**
- Consumes: Task 1 `APP_CONFIG`, Task 2-3 `/api/*` SSE shapes
- Produces: `#notebooks #sources-slot #center-slot #studio-slot #status-pill #theme-toggle #banner-slot` rendered UI

- [ ] **Step 1: Write failing frontend check**

```js
// check must assert OpenBook slots + monet tokens + no trading refs
if (!html.includes('id="notebooks"')) throw new Error("notebooks rail missing");
if (!html.includes('id="center-slot"')) throw new Error("chat slot missing");
if (html.includes("price-chart") || js.includes("getCurrency")) throw new Error("trading code leaked");
if (!css.includes("--cyan") || !css.includes(".panel")) throw new Error("monet tokens missing");
```

- [ ] **Step 2: Run check to verify it fails**

Run: `node scripts/check.mjs`
Expected: FAIL with file-not-found or slot missing

- [ ] **Step 3: Implement `index.html` + `app.css` + `renderer.js`**

`index.html`: monet orbs/topbar (`OpenBook` wordmark + `algo-chip`, `status-pill`, `theme-toggle` localStorage `openbook-theme`), `banner-slot`, 3-rail layout, CSP `connect-src http://127.0.0.1:5678`, classic scripts `renderer.js`. `app.css`: monet `:root --cyan/--bg/--panel` + `.panel/orbs` + light `html.light` overrides + study rails (no canvas chart). `renderer.js`: `BASE=APP_CONFIG.backendUrl`, `boot→waitForBackend(/api/config)→loadConfig→renderHealth/Notebooks/ModelPicker/Chat→startLogStream(EventSource /api/logs, 500 cap)→poll /api/health 5s to clear banner`, `selectNotebook`, `renderSources/Chat/Summary`, `POST chat` streaming with `[source p.X]` links, `POST summary` Studio render.

- [ ] **Step 4: Run check + smoke to verify it passes**

Run: `node scripts/check.mjs`
Expected: PASS. Manual: `npm start` shows shell, `GET /api/config` 200.

- [ ] **Step 5: Commit**

```bash
git add index.html renderer.js app.css macos.css scripts/check.mjs package.json
git commit -m "feat: add monet-shell study frontend"
```

### Task 5: Docs/tests port + Phase 1 pack validation

**Files:**
- Create: `docs/api-reference.md`, `docs/troubleshooting.md`, `README.md`, `SETUP.txt`
- Modify: `tests/*` final fixtures, `.gitignore` (`data/ models/ *.db release/ dist/`)
- Test: full `pytest + check + pack --dir`

**Interfaces:**
- Consumes: Tasks 1-4 complete app
- Produces: shippable Phase 1 `release/win-unpacked/` + validated manual gate

- [ ] **Step 1: Write failing docs/pack check**

```bash
# README must document 5678 + /api + lazy models; api-reference must list /api/chat SSE [DONE]
grep -q "5678" README.md && grep -q "/api/notebooks" docs/api-reference.md
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/check.mjs; python -m pytest tests/ -q`
Expected: FAIL (docs missing) or pack untested

- [ ] **Step 3: Implement docs + gitignore + port remaining tests**

`README.md` (Features/Stack mono: Electron+CJS+Flask+Chroma+Qwen/Install venv+npm/Quick `npm start` Bio101 flow/Checks `npm run check` + `pytest`/API table/Troubleshooting link), `docs/api-reference.md` (all `/api/*` with curl + SSE `[DONE]` + 400/422 table), `troubleshooting.md` (model download, torch CUDA, 5678 busy, Chroma lock, venv paths), `SETUP.txt` (portable copy + `install-deps.bat`), `.gitignore`.

- [ ] **Step 4: Run full validation to verify it passes**

Run: `python -m pytest tests/ -v`
Run: `node scripts/check.mjs`
Run: `npm run pack`
Expected: PASS + `release/win-unpacked/` with `OpenBook.exe`, manual Bio101 → 2 PDFs → cited ask → summary → restart persists. Record `backend.exe` size decision for Phase 2.

- [ ] **Step 5: Commit**

```bash
git add README.md SETUP.txt docs/ .gitignore tests/
git commit -m "docs: add api reference troubleshooting and phase1 pack validation"
```
