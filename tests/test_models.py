# tests/test_models.py — lazy model pipeline (Task 3).
import sys

import pytest

import backend


@pytest.fixture(autouse=True)
def blocked(monkeypatch):
    # Heavy deps must never be required — block them outright.
    for mod in ("torch", "chromadb", "transformers", "sentence_transformers"):
        monkeypatch.setitem(sys.modules, mod, None)
    monkeypatch.setattr(backend, "_llm_pipe", None)
    monkeypatch.setattr(backend, "_embed_model", None)
    monkeypatch.setattr(backend, "_chroma_client", None)


def test_device_cpu_when_torch_blocked():
    assert backend._device() == "cpu"
    assert backend.model_info()["device"] == "cpu"


def test_model_info_shape():
    info = backend.model_info()
    assert info["llm"] == backend.LLM_ID
    assert info["embed"] == backend.EMBED_ID
    assert info["engine"] == "transformers"


def test_get_llm():
    assert backend.get_llm() == backend.LLM_ID


def test_set_llm_valid(monkeypatch):
    monkeypatch.setattr(backend, "LLM_ID", "Qwen/Qwen3-0.6B")
    out = backend.set_llm("Qwen/Qwen2.5-3B-Instruct")
    assert backend.LLM_ID == "Qwen/Qwen2.5-3B-Instruct"
    assert out["llm"] == "Qwen/Qwen2.5-3B-Instruct"


@pytest.mark.parametrize(
    "bad", ["no-slash", "http://x/y", "a/b/c", "", "  ", None, "org/"]
)
def test_set_llm_rejects_bad_id(bad):
    with pytest.raises(ValueError):
        backend.set_llm(bad)


def test_set_llm_unloads_pipe(monkeypatch):
    monkeypatch.setattr(backend, "LLM_ID", "Qwen/Qwen3-0.6B")
    monkeypatch.setattr(backend, "_llm_pipe", object())
    backend.set_llm("Qwen/Qwen3-0.6B")
    assert backend._llm_pipe is None


def test_strip_thinking():
    assert backend._strip_thinking("a <think>secret</think> b") == "a  b"
    assert backend._strip_thinking("answer <think>hmm") == "answer"


def test_llm_stream_chunks(monkeypatch):
    monkeypatch.setattr(
        backend, "llm_generate", lambda prompt, max_new_tokens=512: "abcdef"
    )
    assert list(backend.llm_stream("q", chunk=2)) == ["ab", "cd", "ef"]


def test_heavy_imports_stay_lazy():
    with pytest.raises(Exception):
        backend.llm_generate("hi")
    with pytest.raises(Exception):
        backend.embed_texts(["hi"])
