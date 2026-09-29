# tests/conftest.py — put the flat repo root on sys.path so
# `import backend` works no matter where pytest is invoked from.
import os
import sys

import pytest

import backend

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture(autouse=True)
def _isolated_config(tmp_path, monkeypatch):
    # Backend engine/key/model resolution reads CONFIG_PATH on every LLM
    # call. Without this, tests inherit whoever's real config.json (engine,
    # key, model) and can hit the live network with a real key.
    monkeypatch.setattr(backend, "CONFIG_PATH", tmp_path / "config.json")
