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
