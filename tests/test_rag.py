# tests/test_rag.py — RAG vector store (Task 3).
import sys

import pytest

import backend


class FakeCol:
    def __init__(self):
        self.upserted = None
        self.queried = None

    def upsert(self, **kw):
        self.upserted = kw

    def query(self, **kw):
        self.queried = kw
        return {
            "documents": [["doc-a", "doc-b"]],
            "metadatas": [
                [
                    {"pages": "1", "source": "s.pdf"},
                    {"pages": "2", "source": "s.pdf"},
                ]
            ],
        }


class FakeClient:
    def __init__(self):
        self.cols = {}
        self.deleted = []

    def get_or_create_collection(self, name):
        return self.cols.setdefault(name, FakeCol())

    def delete_collection(self, name):
        self.deleted.append(name)


@pytest.fixture()
def fake_rag(monkeypatch):
    monkeypatch.setattr(backend, "_chroma_client", FakeClient())
    monkeypatch.setattr(
        backend, "embed", lambda texts: [[float(len(t))] for t in texts]
    )
    return backend._chroma_client


def test_upsert_ids_and_meta(fake_rag):
    chunks = [
        {"chunk_id": 0, "text": "hello", "pages": [1]},
        {"chunk_id": 1, "text": "world", "pages": [1, 2]},
    ]
    backend.upsert("nb1", chunks, source="s.pdf")
    col = fake_rag.cols["nb_nb1"]
    assert col.upserted["ids"] == ["s.pdf:0", "s.pdf:1"]
    assert col.upserted["documents"] == ["hello", "world"]
    assert col.upserted["metadatas"] == [
        {"pages": "1", "source": "s.pdf"},
        {"pages": "1,2", "source": "s.pdf"},
    ]
    assert len(col.upserted["embeddings"]) == 2


def test_query_shape_and_k(fake_rag):
    hits = backend.query("nb1", "q", k=4)
    assert fake_rag.cols["nb_nb1"].queried["n_results"] == 4
    assert hits == [
        {"text": "doc-a", "pages": "1", "source": "s.pdf"},
        {"text": "doc-b", "pages": "2", "source": "s.pdf"},
    ]


def test_query_default_k6(fake_rag):
    backend.query("nb1", "q")
    assert fake_rag.cols["nb_nb1"].queried["n_results"] == 6


def test_delete_collection_ok_and_swallows_errors(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(backend, "_chroma_client", client)
    backend.delete_collection("nb1")
    assert client.deleted == ["nb_nb1"]

    class Boom:
        def delete_collection(self, name):
            raise ValueError("gone")

    monkeypatch.setattr(backend, "_chroma_client", Boom())
    backend.delete_collection("nb1")  # must not raise


def test_rag_errors_clear_only_when_used(monkeypatch):
    monkeypatch.setitem(sys.modules, "chromadb", None)
    monkeypatch.setattr(backend, "_chroma_client", None)
    with pytest.raises(RuntimeError, match="chromadb"):
        backend.upsert("n", [], source="s")
    with pytest.raises(RuntimeError, match="chromadb"):
        backend.query("n", "q")
