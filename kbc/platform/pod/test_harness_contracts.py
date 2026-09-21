"""Harness contracts at the tool, snapshot and whole-page verification seams."""
import asyncio
import json
from pathlib import Path

import pytest

import compile_box
import mediaverify
from pi_file_tools import FileTools
from test_mediaverify import FakeEngine, _mk


@pytest.mark.asyncio
async def test_write_and_edit_share_persistence_budget_without_partial_mutation(tmp_path):
    tools = FileTools(str(tmp_path), ["Write", "Edit"], compile_box._make_compile_path_guard(tmp_path), max_write_bytes=12)
    path = tmp_path / "candidate/page.md"
    await tools.write({"file_path": str(path), "content": "界" * 4})
    with pytest.raises(ValueError, match="artifact budget"):
        await tools.write({"file_path": str(path), "content": "界" * 5})
    assert path.read_text() == "界" * 4
    with pytest.raises(ValueError, match="artifact budget"):
        await tools.edit({"file_path": str(path), "old_string": "界", "new_string": "界界", "replace_all": True})
    assert path.read_text() == "界" * 4
    # A legacy oversized page can be repaired down to the permitted budget.
    path.write_text("x" * 20)
    await tools.edit({"file_path": str(path), "old_string": "x" * 20, "new_string": "small"})
    assert path.read_text() == "small"


@pytest.mark.asyncio
async def test_incomplete_snapshot_cannot_commit_or_acknowledge_completion(tmp_path, monkeypatch):
    monkeypatch.setattr(compile_box, "MAX_SYNC_FILE_BYTES", 100)
    _mk(tmp_path, "candidate/index.md", "# Index")
    _mk(tmp_path, "candidate/large.md", "x" * 101)
    run = compile_box.CompileRun("oversized", str(tmp_path), 1)
    run._artifact_ack_required = True
    for flags in [{"commit_input": True}, {"completed_checkpoint": True}, {"durable_barrier": True}]:
        with pytest.raises(compile_box.WorkspaceArtifactError, match="candidate/large.md"):
            await compile_box._sync_workspace(run, {}, **flags)
        assert run.events.empty() and not run._pending_sync_acks
    sent = {"candidate/large.md": "previous-hash"}
    await compile_box._sync_workspace(run, sent)
    events = []
    while not run.events.empty(): events.append(run.events.get_nowait())
    assert any(e["type"] == "summary" for e in events)
    assert sent["candidate/large.md"] == "previous-hash"
    assert not any(a.get("deleted") for e in events for a in e.get("artifacts", []))
    assert (tmp_path / "candidate/large.md").stat().st_size == 101


@pytest.mark.asyncio
async def test_long_page_tail_and_segment_boundary_are_verified(tmp_path):
    _mk(tmp_path, "raw/s/i1.png", "image")
    # The claim starts near one segment boundary, beyond the old prefix cap.
    text = "x" * 47990 + "\nGPU-Util 94%\n" + "y" * 25000
    _mk(tmp_path, "candidate/page.md", text)
    engine = FakeEngine()
    result = await mediaverify.run_blind_verify(engine, str(tmp_path), {"page.md": ["s/i1.png"]})
    assert result["completed_pages"] == ["page.md"] and not result["failed_pages"]
    assert len(result["findings"]) == 1, "overlapping segments must not duplicate the same claim"
    assert result["findings"][0]["claim"] == "GPU-Util 94%"
    segments = list(mediaverify.comparison_segments(text))
    covered = bytearray(len(text))
    for start, end, part in segments:
        assert part == text[start:end] and len(part) <= 24000
        covered[start:end] = b"1" * (end-start)
    assert all(covered)
    assert engine.calls["compare"] == len(segments)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["exception", "missing_findings", "malformed_finding"])
async def test_one_bad_segment_cannot_pass_the_page(tmp_path, failure):
    class Engine(FakeEngine):
        async def run_readonly_agent(self, **kwargs):
            if kwargs.get("role") == "compare" and "TAIL" in kwargs["user_message"]:
                if failure == "exception": raise RuntimeError("fixture failure")
                return json.dumps({} if failure == "missing_findings" else {"findings": [{}]})
            return await super().run_readonly_agent(**kwargs)
    _mk(tmp_path, "raw/s/i1.png", "image")
    _mk(tmp_path, "candidate/page.md", "x" * 25000 + "TAIL")
    result = await mediaverify.run_blind_verify(Engine(), str(tmp_path), {"page.md": ["s/i1.png"]})
    assert result["failed_pages"] == ["page.md"] and not result["completed_pages"]
    assert result["errors"]


@pytest.mark.asyncio
async def test_compare_deadline_is_for_the_whole_page(tmp_path, monkeypatch):
    async def compare(*args, **kwargs):
        await asyncio.sleep(0.03)
        return {"findings": []}
    monkeypatch.setattr(mediaverify, "_agent_json", compare)
    monkeypatch.setenv("KBC_MV_COMPARE_TIMEOUT", "0.05")
    with pytest.raises(TimeoutError):
        await mediaverify.compare_page(None, str(tmp_path), "page.md", "x" * 60000, {})


@pytest.mark.asyncio
async def test_transcript_cache_is_bound_to_content_model_and_prompt(tmp_path, monkeypatch):
    _mk(tmp_path, "raw/s/i1.png", "image")
    engine = FakeEngine()
    cache = {}
    await mediaverify.transcribe_image(engine, str(tmp_path), "s/i1.png", cache)
    cache = mediaverify.load_transcripts(str(tmp_path))
    await mediaverify.transcribe_image(engine, str(tmp_path), "s/i1.png", cache)
    assert engine.calls["transcribe"] == 1
    monkeypatch.setenv("KBC_MV_TRANSCRIBE_MODEL", "another-fixture-model")
    await mediaverify.transcribe_image(engine, str(tmp_path), "s/i1.png", cache)
    monkeypatch.setattr(mediaverify, "TRANSCRIBE_SYSTEM_EN", mediaverify.TRANSCRIBE_SYSTEM_EN + " New instructions.")
    await mediaverify.transcribe_image(engine, str(tmp_path), "s/i1.png", cache)
    assert engine.calls["transcribe"] == 3


def test_internal_prompt_uses_machine_phase_and_keeps_evidence_contract(tmp_path):
    run = compile_box.CompileRun("phase", str(tmp_path), 1)
    for locale in ["en", "zh"]:
        run.locale = locale
        base = compile_box._compile_system_prompt(run)
        assert str(compile_box.MAX_SYNC_FILE_BYTES) in base
        run._batch_stage = "batch_map"
        map_prompt = compile_box._internal_execution_contract(run)
        run._batch_stage = "batch_final"
        final_prompt = compile_box._internal_execution_contract(run)
        assert map_prompt != final_prompt
        assert len(final_prompt.encode()) < 2000
        assert "Raw" in final_prompt or "原料" in final_prompt


def test_same_sized_evidence_replacement_invalidates_survey(tmp_path):
    import redblue
    path = tmp_path / "source.md"
    path.write_text("value=1")
    before = redblue.raw_fingerprint(str(tmp_path))
    path.write_text("value=2")
    assert redblue.raw_fingerprint(str(tmp_path)) != before


def test_prefix_only_media_receipts_do_not_claim_whole_page_verification(tmp_path, monkeypatch):
    import selfcheck
    _mk(tmp_path, "candidate/page.md", "# Page")
    _mk(tmp_path, "raw/image.png", "image")
    current = selfcheck.media_page_fingerprints(str(tmp_path), {"page.md": ["image.png"]})
    monkeypatch.setattr(selfcheck, "MEDIA_VERIFICATION_CONTRACT_VERSION", 1)
    assert selfcheck.media_page_fingerprints(str(tmp_path), {"page.md": ["image.png"]}) != current


@pytest.mark.asyncio
async def test_oversized_transcript_never_becomes_cached_evidence(tmp_path, monkeypatch):
    _mk(tmp_path, "raw/image.png", "image")
    async def oversized(*args, **kwargs):
        return {"facts": [{"value": "x" * 8000}]}
    monkeypatch.setattr(mediaverify, "_agent_json", oversized)
    cache = {}
    with pytest.raises(ValueError, match="evidence budget"):
        await mediaverify.transcribe_image(None, str(tmp_path), "image.png", cache)
    assert not cache and not mediaverify.load_transcripts(str(tmp_path))


@pytest.mark.asyncio
async def test_legacy_aggregate_migrates_atomically_before_strict_checkpoint(tmp_path):
    cache = {f"image-{i}.png": {"sha8": str(i), "transcript": {"facts": [], "notes": "x" * 6000}}
             for i in range(200)}
    _mk(tmp_path, mediaverify.TRANSCRIPTS_PATH, json.dumps(cache))
    assert (tmp_path / mediaverify.TRANSCRIPTS_PATH).stat().st_size > compile_box.MAX_SYNC_FILE_BYTES
    run = compile_box.CompileRun("legacy-cache", str(tmp_path), 1)
    await compile_box._sync_workspace(run, {}, durable_barrier=True)
    event = run.events.get_nowait()
    assert event["type"] == "syncArtifacts"
    assert {"path": mediaverify.TRANSCRIPTS_PATH, "deleted": True} in event["artifacts"]
    recovered = tmp_path / "recovered"
    for artifact in event["artifacts"]:
        if not artifact.get("deleted"):
            _mk(recovered, artifact["path"], artifact["content"])
    assert mediaverify.load_transcripts(str(recovered)) == cache


def test_packaged_worker_symlink_uses_the_actual_node_entrypoint(tmp_path, monkeypatch):
    import pi_engine
    pod = tmp_path / "pod"
    pod.mkdir()
    actual = tmp_path / "worker/dist/kbc/pi-worker.js"
    actual.parent.mkdir(parents=True)
    actual.write_text("// fixture worker")
    (pod / "pi-worker").symlink_to(tmp_path / "worker", target_is_directory=True)
    monkeypatch.setattr(pi_engine, "__file__", str(pod / "pi_engine.py"))
    monkeypatch.setattr(pi_engine.shutil, "which", lambda _: "/fixture/node")
    assert pi_engine.worker_command() == ["/fixture/node", str(actual.resolve())]
