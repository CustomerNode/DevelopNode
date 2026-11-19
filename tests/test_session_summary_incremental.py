"""A growing transcript's summary reads only what was appended.

``load_session_summary`` used to parse the whole transcript each time it
changed; a very large transcript being written by a working session kept the
web server busy enough to make /api/ping slow.  These tests hold the
incremental scan to the same result as a full read in every case that can
happen to a transcript on disk.
"""
import json

import pytest

import web.config as cfg
import web.sessions as sessions


def _line(t, text, ts, **extra):
    obj = {"type": t, "timestamp": ts,
           "message": {"role": t, "content": [{"type": "text", "text": text}]}}
    obj.update(extra)
    return json.dumps(obj) + "\n"


def _clear():
    cfg._summary_cache.clear()
    cfg._summary_cache_index.clear()
    sessions._scan_state.clear()


def _full(path):
    """The summary a cold full read gives."""
    _clear()
    saved = sessions._SCAN_STATE_MIN_BYTES
    sessions._SCAN_STATE_MIN_BYTES = 10 ** 12
    try:
        return sessions.load_session_summary(path)
    finally:
        sessions._SCAN_STATE_MIN_BYTES = saved


def _incremental(path):
    """The summary with saved scan state kept, summary cache dropped."""
    cfg._summary_cache.clear()
    cfg._summary_cache_index.clear()
    return sessions.load_session_summary(path)


@pytest.fixture
def transcript(tmp_path, monkeypatch):
    monkeypatch.setattr(sessions, "_SCAN_STATE_MIN_BYTES", 0)
    _clear()
    p = tmp_path / "proj" / "s1.jsonl"
    p.parent.mkdir()
    p.write_text(
        _line("user", "first question", "2026-01-01T10:00:00Z")
        + _line("assistant", "first answer", "2026-01-01T10:00:05Z"),
        encoding="utf-8")
    yield p
    _clear()


def _same(a, b):
    for k in ("display_title", "custom_title", "message_count", "preview",
              "last_activity_ts", "sort_ts", "file_bytes", "next_step"):
        assert a.get(k) == b.get(k), k


def test_append_matches_a_full_read(transcript):
    _incremental(transcript)
    with open(transcript, "a", encoding="utf-8") as f:
        f.write(_line("user", "second", "2026-01-01T11:00:00Z"))
        f.write(json.dumps({"type": "custom-title", "customTitle": "Named"}) + "\n")
        f.write(_line("assistant", "reply", "2026-01-01T11:00:09Z"))
    inc = _incremental(transcript)
    assert inc["message_count"] == 4
    assert inc["custom_title"] == "Named"
    _same(inc, _full(transcript))


def test_an_append_parses_only_the_new_lines(transcript, monkeypatch):
    _incremental(transcript)
    seen = []
    real = sessions._scan_line
    monkeypatch.setattr(sessions, "_scan_line",
                        lambda s, raw: (seen.append(raw), real(s, raw)))
    with open(transcript, "a", encoding="utf-8") as f:
        f.write(_line("user", "only this", "2026-01-01T12:00:00Z"))
    _incremental(transcript)
    assert [r.strip() for r in seen if r.strip()] == [
        _line("user", "only this", "2026-01-01T12:00:00Z").strip().encode()]


def test_a_half_written_line_is_counted_once_finished(transcript):
    _incremental(transcript)
    whole = _line("user", "being written", "2026-01-01T13:00:00Z")
    with open(transcript, "a", encoding="utf-8") as f:
        f.write(whole[:20])
    half = _incremental(transcript)
    assert half["message_count"] == 2
    with open(transcript, "a", encoding="utf-8") as f:
        f.write(whole[20:])
    done = _incremental(transcript)
    assert done["message_count"] == 3
    _same(done, _full(transcript))


def test_a_complete_last_line_without_newline_counts(transcript):
    _incremental(transcript)
    with open(transcript, "a", encoding="utf-8") as f:
        f.write(_line("user", "no newline", "2026-01-01T14:00:00Z").rstrip("\n"))
    inc = _incremental(transcript)
    assert inc["message_count"] == 3
    _same(inc, _full(transcript))


def test_a_rewritten_file_is_read_again_in_full(transcript):
    _incremental(transcript)
    transcript.write_text(
        _line("user", "different start", "2026-02-01T10:00:00Z")
        + _line("assistant", "x" * 400, "2026-02-01T10:00:01Z")
        + _line("user", "more", "2026-02-01T10:00:02Z"),
        encoding="utf-8")
    inc = _incremental(transcript)
    assert inc["preview"] == "different start"
    _same(inc, _full(transcript))


def test_a_truncated_file_is_read_again_in_full(transcript):
    _incremental(transcript)
    transcript.write_text(_line("user", "only one", "2026-03-01T10:00:00Z"),
                          encoding="utf-8")
    inc = _incremental(transcript)
    assert inc["message_count"] == 1
    _same(inc, _full(transcript))


def test_small_files_keep_no_state(transcript, monkeypatch):
    monkeypatch.setattr(sessions, "_SCAN_STATE_MIN_BYTES", 10 ** 9)
    _incremental(transcript)
    assert str(transcript) not in sessions._scan_state
