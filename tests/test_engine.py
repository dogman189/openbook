# tests/test_engine.py — OpenRouter engine selection + streaming (stubbed HTTP).
import io
import json
import urllib.error

import pytest

import backend


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(backend, "_DB", backend.init_db(str(tmp_path / "api.db")))
    monkeypatch.setattr(backend, "CONFIG_PATH", tmp_path / "config.json")
    monkeypatch.setattr(backend, "_log_queue", __import__("queue").Queue())
    backend.app.config["TESTING"] = True
    return backend.app.test_client()


def test_engine_defaults_local(client):
    body = client.post("/api/engine", json={}).get_json()
    assert body["engine"] == "local"
    assert body["openrouter_key_set"] is False


def test_engine_rejects_unknown(client):
    r = client.post("/api/engine", json={"engine": "skynet"})
    assert r.status_code == 422


def test_engine_roundtrip_and_key_masked(client):
    r = client.post(
        "/api/engine",
        json={"engine": "openrouter", "openrouter_model": "openai/gpt-4o-mini", "openrouter_key": "sk-or-secret"},
    )
    assert r.status_code == 200
    body = r.get_json()
    assert body["engine"] == "openrouter"
    assert body["openrouter_model"] == "openai/gpt-4o-mini"
    assert body["openrouter_key_set"] is True
    # The key is write-only: config readers never see the value itself.
    cfg = client.get("/api/config").get_json()
    assert "openrouter_key" not in cfg
    assert cfg["openrouter_key_set"] is True
    assert cfg["engine"] == "openrouter"


def test_engine_key_clear(client):
    client.post("/api/engine", json={"openrouter_key": "sk-or-secret"})
    client.post("/api/engine", json={"openrouter_key": ""})
    assert client.get("/api/config").get_json()["openrouter_key_set"] is False


def _sse_response(*lines):
    class FakeResp:
        def __init__(self):
            self.closed = False

        def __iter__(self):
            return iter(lines)

        def close(self):
            self.closed = True

    return FakeResp()


def test_openrouter_stream_parses_deltas(monkeypatch):
    monkeypatch.setattr(backend, "get_openrouter_key", lambda: "sk-or-x")
    monkeypatch.setattr(backend, "get_openrouter_model", lambda: "openai/gpt-4o-mini")
    frames = [
        b'data: {"choices": [{"delta": {"content": "hello "}}]}\n',
        b"\n",
        b": comment\n",
        b'data: {"choices": [{"delta": {"content": "world"}}]}\n',
        b"data: [DONE]\n",
    ]
    monkeypatch.setattr(backend, "_openrouter_request", lambda payload, stream: _sse_response(*frames))
    assert "".join(backend._openrouter_stream("hi")) == "hello world"


def test_openrouter_stream_skips_garbage(monkeypatch):
    monkeypatch.setattr(backend, "get_openrouter_key", lambda: "sk-or-x")
    frames = [b"data: not-json\n", b'data: {"choices": []}\n', b"data: [DONE]\n"]
    monkeypatch.setattr(backend, "_openrouter_request", lambda payload, stream: _sse_response(*frames))
    assert "".join(backend._openrouter_stream("hi")) == ""


def _http_error(code, message):
    return urllib.error.HTTPError(
        "https://openrouter.ai/api/v1/chat/completions",
        code,
        "err",
        {},
        io.BytesIO(json.dumps({"error": {"message": message}}).encode()),
    )


def test_openrouter_errors_mapped(monkeypatch):
    import urllib.request

    monkeypatch.setattr(backend, "get_openrouter_key", lambda: "sk-or-x")

    def boom(req, timeout=None):
        raise _http_error(401, "No auth credentials")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    with pytest.raises(backend.OpenRouterError, match="invalid API key"):
        backend._openrouter_complete("hi", 8)

    def boom402(req, timeout=None):
        raise _http_error(402, "Insufficient credits")

    monkeypatch.setattr(urllib.request, "urlopen", boom402)
    with pytest.raises(backend.OpenRouterError, match="out of credits"):
        backend._openrouter_complete("hi", 8)


def test_openrouter_missing_key(monkeypatch):
    monkeypatch.setattr(backend, "get_openrouter_key", lambda: "")
    with pytest.raises(backend.OpenRouterError, match="key missing"):
        backend._openrouter_complete("hi", 8)


def test_ask_surfaces_engine_error_as_token(client, monkeypatch):
    db = backend.get_db()
    nid = backend.create_notebook(db, "nb")

    def boom(prompt):
        raise backend.OpenRouterError("OpenRouter: out of credits.")

    monkeypatch.setattr(
        backend, "query", lambda nid_, q_, k=6: [{"text": "t", "pages": "1", "source": "s"}]
    )
    monkeypatch.setattr(backend, "indexed_count", lambda nid_: 1)
    monkeypatch.setattr(backend, "llm_stream", boom)
    r = client.post(f"/api/notebooks/{nid}/chat", json={"query": "hi"})
    assert r.status_code == 200
    assert "Error: OpenRouter" in r.get_data(as_text=True)


def test_models_lists_engine_block(client):
    body = client.get("/api/models").get_json()
    assert body["engine"]["engine"] == "local"
    assert body["engine"]["openrouter_key_set"] is False
    assert len(body["engine"]["openrouter_models"]) == 3
