# tests/test_api_core.py — Flask /api/config + /api/health (Task 2 core).
import pytest

import backend


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # Isolate both SQLite and the saved-config file per test.
    monkeypatch.setattr(backend, "_DB", backend.init_db(str(tmp_path / "api.db")))
    monkeypatch.setattr(backend, "CONFIG_PATH", tmp_path / "config.json")
    backend.app.config["TESTING"] = True
    return backend.app.test_client()


def test_health_shape(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    data = r.get_json()
    assert data["backend"] == "ok"
    assert data["llm"]
    assert data["embed"]
    assert data["device"] == "cpu"
    assert data["engine"] == "transformers"
    assert {"gpu", "vram_gb", "cuda", "ram_gb", "cpu_count", "os"} <= set(data["specs"])


def test_config_roundtrip(client):
    assert client.get("/api/config").get_json() == {"openrouter_key_set": False}
    r = client.post("/api/config", json={"theme": "dark", "lastNotebook": "abc"})
    assert r.status_code == 200
    assert r.get_json() == {"theme": "dark", "lastNotebook": "abc"}
    body = client.get("/api/config").get_json()
    assert body["theme"] == "dark"
    assert body["openrouter_key_set"] is False


def test_config_rejects_non_object(client):
    r = client.post("/api/config", json=["not", "an", "object"])
    assert r.status_code == 400
    r = client.post("/api/config", data="plain text", content_type="text/plain")
    assert r.status_code == 400


def test_cors_allows_null_origin_for_file_app(client):
    if backend.CORS is None:
        pytest.skip("flask-cors not installed")
    r = client.get("/api/health", headers={"Origin": "null"})
    assert "access-control-allow-origin" in {k.lower() for k in r.headers.keys()}


def test_core_works_with_heavy_deps_blocked(monkeypatch):
    # torch/chromadb must never be required — block them outright.
    import sys

    for mod in ("torch", "chromadb", "transformers", "sentence_transformers"):
        monkeypatch.setitem(sys.modules, mod, None)
    assert backend.get_specs()["cuda"] is False
    assert backend.model_info()["device"] == "cpu"
    assert callable(backend.parse_pdf)
    assert callable(backend.chunk_text)
