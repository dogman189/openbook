# tests/test_api.py — notebook/source/model/log routes (Task 3).
import io
import json
import queue as _queue

import pytest

import backend


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(backend, "_DB", backend.init_db(str(tmp_path / "api.db")))
    monkeypatch.setattr(backend, "CONFIG_PATH", tmp_path / "config.json")
    monkeypatch.setattr(backend, "UPLOADS_DIR", tmp_path / "uploads")
    monkeypatch.setattr(backend, "_log_queue", _queue.Queue())
    backend.app.config["TESTING"] = True
    return backend.app.test_client()


@pytest.fixture()
def nid(client):
    return client.post("/api/notebooks", json={"title": "nb"}).get_json()["id"]


def test_notebooks_crud_and_uploads_rmtree(client):
    r = client.post("/api/notebooks", json={"title": "my nb"})
    assert r.status_code == 200
    nid = r.get_json()["id"]
    assert "my nb" in [n["title"] for n in client.get("/api/notebooks").get_json()]
    up = backend.UPLOADS_DIR / nid
    up.mkdir(parents=True)
    (up / "f.txt").write_text("x")
    assert client.delete(f"/api/notebooks/{nid}").get_json() == {"deleted": nid}
    assert not up.exists()
    assert client.post("/api/notebooks", json={}).status_code == 400
    assert client.post("/api/notebooks", json=["x"]).status_code == 400


def test_sources_paste_and_422(client, nid, monkeypatch):
    monkeypatch.setattr(backend, "upsert", lambda *a, **k: None)
    r = client.post(
        f"/api/notebooks/{nid}/sources",
        json={"text": "hello world " * 50, "title": "note.txt"},
    )
    assert r.status_code == 200
    body = r.get_json()
    assert body == {"sourceId": "note.txt", "pages": 1, "chunks": 1}
    assert len(client.get(f"/api/notebooks/{nid}/sources").get_json()) == 1
    assert client.post(f"/api/notebooks/{nid}/sources", json={}).status_code == 422
    assert (
        client.post(f"/api/notebooks/{nid}/sources", json={"title": "t"}).status_code
        == 422
    )


def test_sources_upload_basename(client, nid, monkeypatch):
    monkeypatch.setattr(backend, "upsert", lambda *a, **k: None)
    monkeypatch.setattr(
        backend, "parse_pdf", lambda path: [{"page": 1, "text": "content " * 100}]
    )
    data = {"file": (io.BytesIO(b"%PDF fake"), "../../evil.pdf")}
    r = client.post(
        f"/api/notebooks/{nid}/sources", data=data, content_type="multipart/form-data"
    )
    assert r.status_code == 200
    assert r.get_json()["sourceId"] == "evil.pdf"
    assert (backend.UPLOADS_DIR / nid / "evil.pdf").exists()


def test_sources_upload_scanned_pdf_400(client, nid, monkeypatch):
    class FakePage:
        def extract_text(self):
            return ""

    class FakeReader:
        def __init__(self, path):
            self.pages = [FakePage()]

    monkeypatch.setattr(backend, "PdfReader", FakeReader)
    data = {"file": (io.BytesIO(b"1" * 300), "scan.pdf")}
    r = client.post(
        f"/api/notebooks/{nid}/sources", data=data, content_type="multipart/form-data"
    )
    assert r.status_code == 400
    assert "Scanned" in r.get_json()["error"]


def test_messages_list(client, nid):
    db = backend.get_db()
    backend.save_message(db, nid, "user", "hi")
    msgs = client.get(f"/api/notebooks/{nid}/messages").get_json()
    assert [m["content"] for m in msgs] == ["hi"]


def test_models_list_shape(client):
    body = client.get("/api/models").get_json()
    assert body["current"] == backend.LLM_ID
    assert len(body["available"]) == 4
    assert {"fits", "reason"} <= set(body["available"][0])
    assert {"gpu", "cuda"} <= set(body["specs"])
    assert body["recommended"]


def test_models_switch_and_422(client, monkeypatch):
    monkeypatch.setattr(backend, "LLM_ID", "Qwen/Qwen3-0.6B")
    r = client.post("/api/models", json={"id": "Qwen/Qwen2.5-1.5B-Instruct"})
    assert r.status_code == 200
    assert r.get_json()["llm"] == "Qwen/Qwen2.5-1.5B-Instruct"
    assert client.post("/api/models", json={"id": "bogus"}).status_code == 422
    assert client.post("/api/models", json=["x"]).status_code == 400


def test_log_post_and_stream_shape(client):
    assert client.post("/api/log", json={"message": "hi"}).get_json() == {
        "status": "ok"
    }
    assert "/api/logs" in {str(r) for r in backend.app.url_map.iter_rules()}
    gen = backend._logs_generate(src=backend._log_queue, timeout=0.01)
    assert next(gen) == "retry: 1000\n\n"
    second = next(gen)
    assert second.startswith("data: ")
    assert json.loads(second.split("data: ", 1)[1])["message"] == "hi"
    gen.close()
    gen2 = backend._logs_generate(src=_queue.Queue(), timeout=0.01)
    assert next(gen2) == "retry: 1000\n\n"
    assert next(gen2) == ": heartbeat\n\n"
    gen2.close()


def _drained_messages():
    out = []
    while not backend._log_queue.empty():
        out.append(backend._log_queue.get_nowait()["message"])
    return out


def test_lifecycle_events_logged(client, nid, monkeypatch):
    monkeypatch.setattr(backend, "upsert", lambda *a, **k: None)
    client.post("/api/notebooks", json={"title": "logged nb"})
    client.post(
        f"/api/notebooks/{nid}/sources",
        json={"text": "hello world " * 50, "title": "n.txt"},
    )
    client.post("/api/models", json={"id": "Qwen/Qwen2.5-1.5B-Instruct"})
    assert client.post("/api/models", json={"id": "bogus"}).status_code == 422
    msgs = _drained_messages()
    assert any("notebook created" in m for m in msgs)
    assert any("source added" in m for m in msgs)
    assert any("model switched" in m for m in msgs)
    assert any(m.startswith("Error:") for m in msgs)


def test_chat_and_summary_log(client, nid, monkeypatch):
    monkeypatch.setattr(backend, "ask_stream", lambda nid_, q_: iter(["tok"]))
    r = client.post(f"/api/notebooks/{nid}/chat", json={"query": "what is x?"})
    assert r.status_code == 200
    assert b"[DONE]" in r.data
    monkeypatch.setattr(backend, "query", lambda nid_, q_, k=6: [])
    monkeypatch.setattr(
        backend,
        "summarize",
        lambda chunks: {"summary": "s", "key_terms": [], "outline": []},
    )
    assert client.post(f"/api/notebooks/{nid}/summary", json={}).status_code == 200
    msgs = _drained_messages()
    assert any(m.startswith("System: ask") for m in msgs)
    assert any("answer done" in m for m in msgs)
    assert any("summary" in m for m in msgs)
