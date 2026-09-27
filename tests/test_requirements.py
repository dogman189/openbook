# tests/test_requirements.py — pin guards for model support.
#
# Regression test: the default + CPU-recommended LLM is Qwen3-0.6B, which
# requires transformers>=4.51.0 (qwen3 arch unknown before that). This fails
# if requirements.txt is ever re-pinned below Qwen3 support.
import re
from pathlib import Path


def _transformers_spec():
    text = (Path(__file__).resolve().parent.parent / "requirements.txt").read_text()
    for line in text.splitlines():
        line = line.strip()
        if re.match(r"transformers\s*(==|>=|~=|>|<=|<)", line):
            return line
    raise AssertionError("no transformers pin found in requirements.txt")


def _floor_version(spec: str):
    m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", spec)
    assert m, f"unparseable transformers spec: {spec!r}"
    major, minor, patch = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
    return major, minor, patch


def test_transformers_supports_qwen3():
    spec = _transformers_spec()
    # Exact pins (==) must already be new enough; floors (>=) must start there.
    assert _floor_version(spec) >= (4, 51, 0), (
        f"{spec!r} predates Qwen3 arch support (needs >=4.51.0); "
        "default model Qwen/Qwen3-0.6B would fail to load"
    )
