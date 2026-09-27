# OpenBook API Reference v1

Base: `http://127.0.0.1:5678` — local-only, no auth. CORS allows `null` (the packaged UI loads over `file://`), `http://localhost:5173`, and `*`. Every route starts with `/api/` — bare paths (`/health`, `/notebooks`) do not exist.

Models: default LLM `Qwen/Qwen3-0.6B` (override `OPENBOOK_LLM_ID`), embeddings `sentence-transformers/all-MiniLM-L6-v2` (override `OPENBOOK_EMBED_ID`), engine `transformers`. Heavy deps load lazily on first AI call.

Error shape (all routes): `{ "error": "<message>" }` with `400` = malformed request / ingest limit, `422` = valid JSON but missing or invalid field.

## Glossary
- **Notebook:** isolated class/exam container with own Sources + history.
- **Source:** PDF or pasted text added to a Notebook.
- **Chunk:** ~800-word slice (100-word overlap) with page refs.
- **Citation:** `[sourceName p.N]` — every fact must cite.
- **Ask:** grounded Q&A over top-6 chunks.

---

### GET /api/config
Readiness probe + saved renderer config. Missing/corrupt `config.json` → `{}` (still 200, so Electron's `waitForBackend` succeeds).

```bash
curl http://127.0.0.1:5678/api/config
```
**Response:** `{ "theme": "dark", "lastNotebook": "a1b2c3d4" }` (or `{}`)

### POST /api/config
Merge posted keys over saved config and persist.

```bash
curl -X POST http://127.0.0.1:5678/api/config -H "Content-Type: application/json" -d "{\"theme\":\"dark\"}"
```
**Request:** `{ "theme": "dark" }` (any JSON object)
**Response:** merged config object
**Errors:**
- 400 - Non-object body: `{ "error": "config must be a JSON object" }`

### GET /api/health
Backend + study engine status + machine specs.

```bash
curl http://127.0.0.1:5678/api/health
```
**Response:**
```json
{ "backend": "ok", "llm": "Qwen/Qwen3-0.6B", "embed": "sentence-transformers/all-MiniLM-L6-v2", "device": "cpu", "engine": "transformers", "specs": { "gpu": null, "vram_gb": 0.0, "cuda": false, "ram_gb": 15.9, "cpu_count": 8, "os": "Windows" } }
```

### GET /api/models
Model switcher payload: current id, 4 presets each with GPU fit, specs, recommended pick, current fit.

```bash
curl http://127.0.0.1:5678/api/models
```
**Response:**
```json
{ "current": "Qwen/Qwen3-0.6B", "available": [{ "id": "Qwen/Qwen3-0.6B", "label": "Qwen 0.6B — fastest", "vram": "~2GB", "min_vram": 2, "fits": true, "reason": "CPU-safe choice" }], "specs": {}, "recommended": "Qwen/Qwen3-0.6B", "current_fit": { "fits": true, "reason": "CPU-safe choice" } }
```

### POST /api/models
Switch LLM. Custom HuggingFace ids allowed if they look like `org/name`. Unloads the old pipeline to free VRAM.

```bash
curl -X POST http://127.0.0.1:5678/api/models -H "Content-Type: application/json" -d "{\"id\":\"Qwen/Qwen2.5-1.5B-Instruct\"}"
```
**Request:** `{ "id": "Qwen/Qwen2.5-1.5B-Instruct" }`
**Response:** `{ "llm": "Qwen/Qwen2.5-1.5B-Instruct", "embed": "sentence-transformers/all-MiniLM-L6-v2", "device": "cpu", "engine": "transformers" }`
**Errors:**
- 400 - Non-object body: `{ "error": "model must be a JSON object" }`
- 422 - Bad id (not `org/name`): `{ "error": "Not a valid HuggingFace model id: 'bogus'" }`

### GET /api/notebooks
List Notebooks ordered by creation (newest first).

```bash
curl http://127.0.0.1:5678/api/notebooks
```
**Response:** `[ { "id": "a1b2c3d4", "title": "Bio 101 - Midterm", "created_at": 1727.0 } ]`

### POST /api/notebooks
Create a Notebook.

```bash
curl -X POST http://127.0.0.1:5678/api/notebooks -H "Content-Type: application/json" -d "{\"title\":\"Bio 101 - Midterm\"}"
```
**Request:** `{ "title": "Bio 101 - Midterm" }`
**Response:** `{ "id": "a1b2c3d4" }`
**Errors:**
- 400 - Non-object body: `{ "error": "notebook must be a JSON object" }`
- 400 - Missing/blank title: `{ "error": "title required" }`

### `DELETE /api/notebooks/<id>`
Delete Notebook + its vector collection + `data/uploads/<id>/`.

```bash
curl -X DELETE http://127.0.0.1:5678/api/notebooks/a1b2c3d4
```
**Response:** `{ "deleted": "a1b2c3d4" }`

### `POST /api/notebooks/<id>/sources`
Add Source (PDF multipart OR JSON text). PDF filenames are `basename()`-sanitized so `../../evil.pdf` stays inside `data/uploads/<id>/`.

PDF:
```bash
curl -X POST http://127.0.0.1:5678/api/notebooks/a1b2c3d4/sources -F file=@lec1.pdf
```
Text:
```bash
curl -X POST http://127.0.0.1:5678/api/notebooks/a1b2c3d4/sources -H "Content-Type: application/json" -d "{\"type\":\"text\",\"title\":\"paste-1\",\"text\":\"Mitosis steps...\"}"
```
**Response:** `{ "sourceId": "lec1.pdf", "pages": 42, "chunks": 180 }`
**Errors:**
- 400 - Over 100MB: `{ "error": "PDF over 100MB limit" }`
- 400 - Over 1000 pages: `{ "error": "PDF over 1000 pages limit" }`
- 400 - Corrupt PDF: `{ "error": "Corrupt PDF: ..." }`
- 400 - Scanned PDF, no OCR engine: `{ "error": "OCR unavailable: install Tesseract ..." }`
- 400 - Scanned PDF, OCR yielded too little: `{ "error": "Scanned PDF — text still too short after OCR" }`
- 422 - JSON without `text`: `{ "error": "text required" }`

### `GET /api/notebooks/<id>/sources`
List Sources for a Notebook.

```bash
curl http://127.0.0.1:5678/api/notebooks/a1b2c3d4/sources
```

### `GET /api/notebooks/<id>/messages`
Restores Ask history for UI reload. Returns `[{id, notebook_id, role, content, citations_json, created_at}]` ordered oldest first.

```bash
curl http://127.0.0.1:5678/api/notebooks/a1b2c3d4/messages
```

### `POST /api/notebooks/<id>/chat` (SSE)
Ask — saves the user message, streams tokens as `data: {"token": ...}`, saves the assistant message, then sends `data: [DONE]`. Answers only from top-6 chunks; unknown → the assistant text is exactly `Not in your sources.`

```bash
curl -N -X POST http://127.0.0.1:5678/api/notebooks/a1b2c3d4/chat -H "Content-Type: application/json" -d "{\"query\":\"What checkpoints?\"}"
```
**Request:** `{ "query": "What checkpoints?" }`
**Stream events:**
```
data: {"token": "Mitosis..."}
data: [DONE]
```
**Errors:**
- 400 - Non-object body: `{ "error": "chat must be a JSON object" }`
- 422 - Missing/blank query: `{ "error": "query required" }`

### `POST /api/notebooks/<id>/summary`
Generate Summary + key terms + outline: queries top-12 chunks, maps the first 8 into 3-bullet notes, reduces to labeled sections.

```bash
curl -X POST http://127.0.0.1:5678/api/notebooks/a1b2c3d4/summary -H "Content-Type: application/json" -d "{\"sourceIds\":[\"lec1.pdf\"]}"
```
**Request:** `{ "sourceIds": ["lec1.pdf"] }` (`sourceIds` optional — currently informational, retrieval always covers the Notebook)
**Response:** `{ "summary": "...", "key_terms": ["mitosis", "checkpoint"], "outline": ["..."] }`
**Errors:**
- 400 - Non-object body: `{ "error": "summary must be a JSON object" }`

### `GET /api/notebooks/<id>/summaries`
List saved summaries (newest first).

```bash
curl http://127.0.0.1:5678/api/notebooks/a1b2c3d4/summaries
```

### GET /api/logs (SSE)
Live backend log stream for the Studio panel. First frame is `retry: 1000`, then one `data: {"message", "ts"}` frame per log, `: heartbeat` every 15s idle.

```bash
curl -N http://127.0.0.1:5678/api/logs
```
**Stream events:**
```
retry: 1000

data: {"message": "backend ready", "ts": 1727.0}

: heartbeat

```

### POST /api/log
Append a renderer-side message to the log stream. Empty `message` is accepted and ignored.

```bash
curl -X POST http://127.0.0.1:5678/api/log -H "Content-Type: application/json" -d "{\"message\":\"ask started\"}"
```
**Response:** `{ "status": "ok" }`
