# tests/test_specs.py — hardware specs + model fit (Task 2, Flask core).
from backend import MIN_VRAM, fits_model, get_specs, model_info, recommend_llm


def test_recommend_cpu_only():
    assert recommend_llm({"cuda": False}) == "Qwen/Qwen3-0.6B"


def test_recommend_gpu_tiers():
    assert recommend_llm({"cuda": True, "vram_gb": 24}) == "Qwen/Qwen2.5-7B-Instruct"
    assert recommend_llm({"cuda": True, "vram_gb": 12}) == "Qwen/Qwen2.5-3B-Instruct"
    assert recommend_llm({"cuda": True, "vram_gb": 6}) == "Qwen/Qwen2.5-1.5B-Instruct"
    assert recommend_llm({"cuda": True, "vram_gb": 3}) == "Qwen/Qwen3-0.6B"


def test_fits_model_cpu_allows_only_tiny():
    ok = fits_model("Qwen/Qwen3-0.6B", {"cuda": False})
    assert ok["fits"] is True
    no = fits_model("Qwen/Qwen2.5-7B-Instruct", {"cuda": False})
    assert no["fits"] is False


def test_fits_model_unknown_custom_id():
    assert fits_model("someone/custom-9B", {"cuda": True, "vram_gb": 99})["fits"] is True


def test_min_vram_covers_all_presets():
    from backend import AVAILABLE_MODELS

    assert {m["id"] for m in AVAILABLE_MODELS} <= set(MIN_VRAM)


def test_get_specs_shape_without_torch(monkeypatch):
    import sys

    # Block torch even if installed (e.g. GPU box) — unit core needs no GPU.
    monkeypatch.setitem(sys.modules, "torch", None)
    specs = get_specs()
    assert {"gpu", "vram_gb", "cuda", "ram_gb", "cpu_count", "os"} <= set(specs)
    assert specs["cuda"] is False


def test_model_info_stub_needs_no_torch():
    info = model_info()
    assert info == {
        "llm": info["llm"],
        "embed": "sentence-transformers/all-MiniLM-L6-v2",
        "device": "cpu",
        "engine": "transformers",
    }
    assert info["llm"]
