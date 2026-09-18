"""Operation failure must follow a durable checkpoint, not conversational idle."""
import asyncio
import json

import pytest

import compile_box
from agent_protocol import AgentEvent


class FailedClient:
    def __init__(self, status=None):
        self.status = status

    async def receive_messages(self):
        yield AgentEvent("result", "fixture", data={
            "outcome": "aborted", "error": "interrupted", "tool_calls": 1,
            "api_error_status": self.status,
        })


@pytest.mark.asyncio
@pytest.mark.parametrize("status,code", [(None, "model_result_error"), (402, "quota_exhausted")])
async def test_failed_authoring_saves_full_tree_before_terminal(tmp_path, monkeypatch, status, code):
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    for i in range(19):
        (candidate / f"page-{i}.md").write_text(f"# Page {i}\n")
    run = compile_box.CompileRun("failed-authoring", str(tmp_path), 1)
    run._artifact_ack_required = True
    checked = []
    (tmp_path / "authoring").mkdir()
    (tmp_path / "authoring" / "SELFCHECK.json").write_text(
        json.dumps({"version": 1, "state": "passed", "converge_phase": "settled"}))

    async def check(_run, *, allow_repair=True):
        checked.append(allow_repair)

    async def background():
        try:
            await asyncio.Future()
        finally:
            (candidate / "page-18.md").write_text("# Final background write\n")

    async def driver(run):
        run._begin_turn("update", authoring_action="compile.incremental")
        run._media_task = asyncio.create_task(background())
        await asyncio.sleep(0)
        # An earlier periodic enqueue already advanced the diff cursor.
        run._sync_sent.update(compile_box._workspace_sync_cursor(run.workdir))
        await compile_box._consume_turn_stream(run, FailedClient(status), stop_on_result=False)

    monkeypatch.setattr(compile_box, "_post_turn_selfcheck", check)
    monkeypatch.setattr(compile_box, "_COMPILE_IMPL", driver)
    task = asyncio.create_task(compile_box._run_wrapper(run))
    try:
        async with asyncio.timeout(2):
            notice = await run.events.get()
            assert notice["type"] == "summary"
            event = await run.events.get()
            assert event["type"] == "syncArtifacts"
            assert len([a for a in event["artifacts"] if a["path"].startswith("candidate/")]) == 19
            report = next(a for a in event["artifacts"] if a["path"] == "authoring/SELFCHECK.json")
            assert "converge_phase" not in json.loads(report["content"])
            assert not event.get("commit_input")
            assert next(a for a in event["artifacts"] if a["path"] == "candidate/page-18.md")["content"] == "# Final background write\n"
            assert checked == [False]
            assert run._media_task.done()
            assert not task.done() and run.events.empty(), "terminal state escaped before save ACK"
            run._pending_sync_acks[event["sync_id"]].set_result(None)
            await task
        events = []
        while not run.events.empty():
            events.append(run.events.get_nowait())
        assert [e["type"] for e in events] == ["error", "turn_done", "end"]
        assert events[0]["code"] == code
        assert not events[0].get("recoverable")
        assert events[0]["stage"] == "model_turn"
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_owner_chat_failure_does_not_inherit_command_identity(tmp_path, monkeypatch):
    run = compile_box.CompileRun("chat", str(tmp_path), 1)
    run._command_context = ("old-operation", 1)
    run._begin_turn("compile", authoring_action="compile.incremental")
    run._begin_turn("ordinary question")
    run._sync_sent = {}

    async def check(*args, **kwargs):
        pass

    monkeypatch.setattr(compile_box, "_post_turn_selfcheck", check)
    await compile_box._consume_turn_stream(run, FailedClient(), stop_on_result=True)
    error = run.events.get_nowait()
    assert error["type"] == "error" and error["recoverable"] is True
    assert run.events.get_nowait()["type"] == "turn_done"
    assert run._upgrade_idle_ready


@pytest.mark.asyncio
async def test_save_failure_retains_workspace_until_retry(tmp_path, monkeypatch):
    run = compile_box.CompileRun("save-retry", str(tmp_path), 1)
    run._artifact_ack_required = True
    gate = asyncio.Event()
    calls = []
    real_sleep = asyncio.sleep

    async def sync(run, sent, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise TimeoutError("ack unavailable")
        await gate.wait()

    async def retry_delay(_seconds):
        await real_sleep(0)

    monkeypatch.setattr(compile_box, "_sync_workspace", sync)
    monkeypatch.setattr(compile_box.asyncio, "sleep", retry_delay)
    task = asyncio.create_task(compile_box._checkpoint_failed_workspace(run, {}))
    try:
        async with asyncio.timeout(2):
            notice = await run.events.get()
            assert notice["type"] == "summary"
            await real_sleep(0)
            assert not task.done() and run.events.empty()
            gate.set()
            await task
        assert calls == [{"force": True, "durable_barrier": True, "retain_until_ack": True}] * 2
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_ack_timeouts_retain_one_snapshot(tmp_path, monkeypatch):
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    (candidate / "index.md").write_text("# Saved work\n")
    run = compile_box.CompileRun("slow-save", str(tmp_path), 1)
    run._artifact_ack_required = True
    monkeypatch.setattr(compile_box, "ARTIFACT_ACK_TIMEOUT_SECS", 0.01)
    sent = {}
    task = asyncio.create_task(compile_box._checkpoint_failed_workspace(run, sent))
    try:
        event = await asyncio.wait_for(run.events.get(), 1)
        await asyncio.sleep(0.04)
        assert not task.done() and not sent
        assert run.events.empty(), "each ACK timeout enqueued another workspace"
        assert len(run._pending_sync_events) == len(run._pending_sync_acks) == 1
        run._pending_sync_acks[event["sync_id"]].set_result(True)
        await asyncio.wait_for(task, 1)
        assert "candidate/index.md" in sent
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("next_chunk", [False, True])
async def test_failed_run_fences_real_media_finalizer(tmp_path, monkeypatch, next_chunk):
    """Exercise the real cancelled media finally, including its drain/settle seam."""
    (tmp_path / "candidate").mkdir()
    (tmp_path / "candidate" / "index.md").write_text("# Saved work\n")
    run = compile_box.CompileRun("media-finalizer", str(tmp_path), 1)
    entered = asyncio.Event()
    providers = []
    due_calls = 0

    def due(_run):
        nonlocal due_calls
        due_calls += 1
        return {"page.md": ["image.png"]} if due_calls == 1 or (next_chunk and due_calls == 2) else None

    async def verify(*args, **kwargs):
        providers.append(asyncio.current_task())
        entered.set()
        await asyncio.Future()

    async def check(*args, **kwargs):
        pass

    async def driver(run):
        run._begin_turn("update", authoring_action="compile.incremental")
        assert compile_box._maybe_start_media_verify(run)
        await entered.wait()
        raise compile_box.ModelResultError("interrupted after writing")

    monkeypatch.setattr(compile_box, "_media_verify_due", due)
    monkeypatch.setattr(compile_box, "_pk_due", lambda run: None)
    monkeypatch.setattr(compile_box.mediaverify, "run_blind_verify", verify)
    monkeypatch.setattr(compile_box, "_post_turn_selfcheck", check)
    monkeypatch.setattr(compile_box, "_COMPILE_IMPL", driver)
    try:
        await asyncio.wait_for(compile_box._run_wrapper(run), 2)
        await asyncio.sleep(0)
        assert len(providers) == 1 and all(t.done() for t in providers), "cancel spawned a new verifier"
        events = []
        while not run.events.empty():
            events.append(run.events.get_nowait())
        for event in events:
            if event["type"] == "syncArtifacts":
                for artifact in event["artifacts"]:
                    if artifact["path"] == "authoring/SELFCHECK.json":
                        assert json.loads(artifact["content"]).get("converge_phase") != "settled", "cancel promoted the failed draft"
        assert next(e for e in events if e["type"] == "error")["code"] == "model_result_error"
    finally:
        monkeypatch.setattr(compile_box, "_media_verify_due", lambda run: None)
        for task in providers:
            if not task.done():
                task.cancel()
        await asyncio.gather(*providers, return_exceptions=True)


@pytest.mark.asyncio
async def test_shutdown_waits_for_real_media_finalizer_after_slot_release(tmp_path, monkeypatch):
    """A finalizer waiting to sync is still a writer after _media_task is None."""
    (tmp_path / "candidate").mkdir()
    (tmp_path / "candidate" / "index.md").write_text("# Saved work\n")
    run = compile_box.CompileRun("released-slot", str(tmp_path), 1)
    run._sync_sent = {}
    entered = asyncio.Event()
    finish = asyncio.Event()
    due_calls = 0

    def due(_run):
        nonlocal due_calls
        due_calls += 1
        return {"page.md": ["image.png"]} if due_calls == 1 else None

    async def verify(*args, **kwargs):
        entered.set()
        await finish.wait()
        return {"findings": [], "errors": [], "images": 1}

    monkeypatch.setattr(compile_box, "_media_verify_due", due)
    monkeypatch.setattr(compile_box, "_pk_due", lambda run: None)
    monkeypatch.setattr(compile_box.mediaverify, "run_blind_verify", verify)
    monkeypatch.setattr(compile_box, "_settle_media_outcome", lambda *args: [])
    assert compile_box._maybe_start_media_verify(run)
    task = run._media_task
    try:
        async with asyncio.timeout(2):
            await entered.wait()
            # Hold the sync lock only once this flow reaches its finalizer:
            # ordinary result sync must complete before it releases the slot.
            original_set = compile_box._set_converge_phase
            at_settle = asyncio.Event()

            async def set_phase(run, phase):
                if phase == "settled":
                    await run._sync_lock.acquire()
                    at_settle.set()
                await original_set(run, phase)

            monkeypatch.setattr(compile_box, "_set_converge_phase", set_phase)
            finish.set()
            await at_settle.wait()
            assert run._media_task is None and not task.done()
            await compile_box._cancel_verification_tasks(run)
            assert task.done(), "released-slot finalizer escaped the cancellation join"
            run._sync_lock.release()
            await compile_box._checkpoint_failed_workspace(run, run._sync_sent)
        while not run.events.empty():
            event = run.events.get_nowait()
            for artifact in event.get("artifacts", []):
                if artifact["path"] == "authoring/SELFCHECK.json":
                    assert json.loads(artifact["content"]).get("converge_phase") != "settled"
        assert not compile_box._maybe_start_media_verify(run)
        assert not compile_box._maybe_start_pk(run)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        if run._sync_lock.locked():
            run._sync_lock.release()
