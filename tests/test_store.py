# tests/test_store.py — SQLite store round-trips (Task 2, Flask core).
import json

import backend
from backend import (
    create_notebook,
    delete_notebook,
    init_db,
    list_messages,
    list_notebooks,
    list_sources,
    list_summaries,
    log_event,
    save_message,
    save_source,
    save_summary,
)


def test_create_and_list_notebook(tmp_path):
    conn = init_db(str(tmp_path / "t.db"))
    nid = create_notebook(conn, "Bio 101")
    assert any(r["id"] == nid for r in list_notebooks(conn))


def test_messages_roundtrip(tmp_path):
    conn = init_db(str(tmp_path / "t.db"))
    nid = create_notebook(conn, "Chem")
    save_message(conn, nid, "user", "What is mitosis?", '[{"source": "lec1"}]')
    mid = save_message(conn, nid, "assistant", "Cell division.")
    rows = list_messages(conn, nid)
    assert [r["role"] for r in rows] == ["user", "assistant"]
    assert any(r["id"] == mid and r["content"] == "Cell division." for r in rows)


def test_sources_summaries_events_and_delete(tmp_path):
    conn = init_db(str(tmp_path / "t.db"))
    nid = create_notebook(conn, "Physics")
    sid = save_source(conn, nid, "lec1.pdf", "pdf", 12, "/tmp/lec1.pdf")
    assert any(r["id"] == sid and r["pages"] == 12 for r in list_sources(conn, nid))
    log_event(conn, nid, "ingest", json.dumps({"pages": 12}))
    sum_id = save_summary(conn, nid, json.dumps([sid]), "Mitosis overview")
    assert any(r["id"] == sum_id for r in list_summaries(conn, nid))
    delete_notebook(conn, nid)
    assert list_notebooks(conn) == []
    assert list_sources(conn, nid) == []
    assert list_messages(conn, nid) == []
    assert list_summaries(conn, nid) == []


def test_notebook_ids_are_short_uuids(tmp_path):
    conn = init_db(str(tmp_path / "t.db"))
    nid = create_notebook(conn, "Short")
    assert len(nid) == 8
    assert backend._new_id() != backend._new_id()
