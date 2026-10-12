"""Exercise worker ownership through the production batch and planner drivers."""

import asyncio
from types import SimpleNamespace

import pytest

import compile_box
from agent_protocol import AgentEvent, AgentTransportError


class Client:
    returncode = None

    def __init__(self, events=(), on_query=None):
        self.events = events
        self.on_query = on_query
        self.connected = False
        self.disconnected = False
        self.interrupts = 0

    async def connect(self):
        self.connected = True

    async def query(self, text):
        if self.on_query:
            await self.on_query()

    async def receive_messages(self):
        for event in self.events:
            if isinstance(event, Exception):
                raise event
            yield event

    async def disconnect(self):
        self.disconnected = True

    async def interrupt(self):
        self.interrupts += 1


def assistant(text):
    return AgentEvent("assistant", "worker", data={"content": [{"type": "text", "text": text}]})


def result(outcome="completed"):
    return AgentEvent("result", "worker", data={"outcome": outcome})


def drain(run):
    events = []
    while not run.events.empty():
        events.append(run.events.get_nowait())
    return events


@pytest.fixture
def run(tmp_path, monkeypatch):
    run = compile_box.CompileRun("fixture-run", str(tmp_path), 1)
    run.client = Client()
    run._turn_text = ["owner reply"]
    run._batch_active = True
    monkeypatch.setattr(compile_box, "_compile_system_prompt", lambda _: "fixture")
    return run


async def test_batch_keeps_conversation_client_and_returns_only_its_reply(run, monkeypatch):
    owner = run.client

    async def observe_owner():
        assert run.client is owner
        assert not owner.disconnected

    worker = Client([assistant("step output"), result()], observe_owner)
    monkeypatch.setattr(compile_box, "_compile_session_client", lambda *a, **kw: worker)
    reply = await compile_box._drive_batch_session(run, "compile scope", "fixture")
    assert reply == "step output"
    assert run._turn_text == ["owner reply"]
    assert run.client is owner and not owner.disconnected
    assert worker.disconnected and run._active_step is None
    assert not run._turn_active
    assert not any(e["type"] in {"turn_done", "syncArtifacts"} for e in drain(run))


async def test_batch_rebuild_discards_only_failed_worker_text(run, monkeypatch):
    failed = Client([assistant("incomplete"), AgentTransportError("fixture disconnect")])
    recovered = Client([assistant("recovered"), result()])
    workers = iter([failed, recovered])
    monkeypatch.setattr(compile_box, "_compile_session_client", lambda *a, **kw: next(workers))
    assert await compile_box._drive_batch_session(run, "compile scope", "fixture") == "recovered"
    assert failed.disconnected and recovered.disconnected
    assert run._turn_text == ["owner reply"]
    assert run._active_step is None
    assert not any(e["type"] == "turn_done" for e in drain(run))


async def test_failed_step_does_not_finalize_conversation_or_commit(run, monkeypatch):
    worker = Client([assistant("partial"), result("failed")])
    monkeypatch.setattr(compile_box, "_compile_session_client", lambda *a, **kw: worker)
    with pytest.raises(compile_box.ModelResultError):
        await compile_box._drive_batch_session(run, "compile scope", "fixture")
    assert run._turn_text == ["owner reply"]
    assert run._active_step is None and not run._turn_active
    assert worker.disconnected
    assert not any(e["type"] in {"turn_done", "syncArtifacts"} for e in drain(run))


@pytest.mark.parametrize("message,code", [
    ("KBC_MODEL_CALL_BUDGET_EXCEEDED", "model_call_budget_exceeded"),
    ("provider echoed KBC_MODEL_CALL_BUDGET_EXCEEDED in private content", "model_result_error"),
])
async def test_model_call_budget_keeps_its_failure_identity(run, monkeypatch, message, code):
    worker = Client([AgentEvent("result", "worker", data={
        "outcome": "failed", "error": message,
        "model_calls": 150, "tool_calls": 316,
    })])
    monkeypatch.setattr(compile_box, "_compile_session_client", lambda *a, **kw: worker)
    with pytest.raises(compile_box.ModelResultError) as error:
        await compile_box._drive_batch_session(run, "review scope", "final review")
    assert compile_box._batch_error_code(error.value) == code


async def test_batch_observations_carry_only_the_controlled_execution_stage(run):
    from execution_observation import ExecutionObserver

    @compile_box._observe_pi_sessions
    async def observe(run):
        observer = ExecutionObserver("session", {"role": "compile", "model": {"id": "fixture", "provider": "fixture"}})
        await observer.emit("tool_start", {"call_id": "call", "name": "Read"}, "turn")

    run._batch_stage = "batch_final"
    await observe(run)
    assert (await run.events.get())["observation"]["data"]["compile_stage"] == "batch_final"
    run._batch_stage = "private-source-name"
    await observe(run)
    assert "compile_stage" not in (await run.events.get())["observation"]["data"]


async def test_final_failure_waits_for_full_workspace_ack(run, monkeypatch, tmp_path):
    import json

    (tmp_path / "raw").mkdir()
    (tmp_path / "raw/source.md").write_text("Synthetic source")
    (tmp_path / "candidate").mkdir()
    (tmp_path / "candidate/index.md").write_text("# Index\n")
    (tmp_path / "authoring").mkdir()
    plan = {"phase": "final", "mode": "flat", "batches": [
        {"id": "b01", "sources": ["source.md"], "status": "done"}], "budget": 1000}
    monkeypatch.setattr(compile_box, "_load_batch_plan", lambda _: plan)
    monkeypatch.setattr(compile_box, "_batch_plan_resumable", lambda _: True)
    monkeypatch.setattr(compile_box, "_materialize_batch_slices", lambda *a: {})
    run._artifact_ack_required = True
    run._sync_sent = {}

    async def edit():
        (tmp_path / "candidate/review.md").write_text(
            "---\ntype: concept\ntitle: Review\nsources:\n"
            "  - resource: raw/source.md\n---\n# Saved final-review work\n")
        (tmp_path / "authoring/SELFCHECK.json").write_text(json.dumps({
            "version": 1, "state": "passed", "converge_phase": "settled"}))

    worker = Client([AgentEvent("result", "worker", data={
        "outcome": "failed", "error": "KBC_MODEL_CALL_BUDGET_EXCEEDED",
    })], edit)
    monkeypatch.setattr(compile_box, "_compile_session_client", lambda *a, **kw: worker)
    task = asyncio.create_task(compile_box._run_batch_compile(run, "resume"))
    saved = False
    events = []
    try:
        async with asyncio.timeout(3):
            while True:
                event = await run.events.get()
                events.append(event)
                if event["type"] == "syncArtifacts":
                    artifacts = {a["path"]: a.get("content", "") for a in event["artifacts"]}
                    if "candidate/review.md" in artifacts:
                        assert not event.get("commit_input")
                        assert "converge_phase" not in json.loads(artifacts["authoring/SELFCHECK.json"])
                        assert not task.done(), "failure escaped before save ACK"
                        saved = True
                    run._pending_sync_acks[event["sync_id"]].set_result(None)
                if event["type"] == "error":
                    assert saved, "failed final session published failure before saving its edits"
                    assert event["code"] == "model_call_budget_exceeded"
                    assert event["stage"] == "batch_final"
                    break
            await task
        events.extend(drain(run))
        assert plan["phase"] == "final"
        assert not any(e.get("commit_input") for e in events)
        assert "converge_phase" not in json.loads((tmp_path / "authoring/SELFCHECK.json").read_text())
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_step_cancellation_retains_ownership_until_teardown(run):
    entered, teardown, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def wait_for_cancel():
        entered.set()
        await asyncio.Future()

    class SlowClose(Client):
        async def disconnect(self):
            teardown.set()
            await release.wait()
            await super().disconnect()

    worker = SlowClose(on_query=wait_for_cancel)
    task = asyncio.create_task(compile_box._execute_compile_step(run, worker, "compile scope"))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        await asyncio.wait_for(teardown.wait(), 1)
        assert run._active_step.client is worker
        competitor = Client()
        with pytest.raises(RuntimeError, match="already owns execution"):
            await compile_box._execute_compile_step(run, competitor, "other scope")
        assert not competitor.connected
        with pytest.raises(RuntimeError, match="owns execution"):
            await run.inject_user_message("unrelated repair")
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert worker.disconnected and run._active_step is None
    assert not run._turn_active and not run._stall_retrying
    assert not run.client.disconnected


async def test_cancel_during_hung_cleanup_stays_cancelled_and_quarantined(run, monkeypatch):
    monkeypatch.setattr(compile_box, "_WORKER_TEARDOWN_TIMEOUT_S", 0.01)
    entered, release = asyncio.Event(), asyncio.Event()

    class HungClose(Client):
        async def disconnect(self):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()

    task = asyncio.create_task(compile_box._execute_compile_step(run, HungClose([result()]), "scope"))
    try:
        await asyncio.wait_for(entered.wait(), 0.5)
        task.cancel()
        done, _ = await asyncio.wait({task}, timeout=0.5)
        assert task in done
        with pytest.raises(asyncio.CancelledError):
            await task
        assert run._active_step.teardown_failed
        assert not any(event["type"] in {"error", "syncArtifacts"} for event in drain(run))
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
        if run._active_step and run._active_step.task:
            await asyncio.gather(run._active_step.task, return_exceptions=True)


async def test_watchdog_targets_step_worker_without_interrupting_owner(run, monkeypatch):
    entered = asyncio.Event()
    owner = run.client
    monkeypatch.setattr(compile_box, "_MODEL_WATCHDOG_POLL_S", 0.001)

    class ExitedClient(Client):
        returncode = 1

        async def connect(self):
            self.owner_task = asyncio.current_task()
            await super().connect()

        async def disconnect(self):
            assert asyncio.current_task() is self.owner_task
            await super().disconnect()

        async def receive_messages(self):
            entered.set()
            while not self.disconnected:
                await asyncio.sleep(0.001)
            if False:
                yield

    worker = ExitedClient()
    watchdog = asyncio.create_task(compile_box._model_stall_watchdog(run))
    try:
        with pytest.raises(compile_box.ModelStallError):
            await asyncio.wait_for(compile_box._execute_compile_step(run, worker, "compile scope"), 1)
    finally:
        run.done = True
        watchdog.cancel()
        with pytest.raises(asyncio.CancelledError):
            await watchdog
    assert entered.is_set() and worker.disconnected
    assert not owner.disconnected and owner.interrupts == 0
    assert run._turn_text == ["owner reply"]
    assert not any(e["type"] == "turn_done" for e in drain(run))


async def test_watchdog_interrupt_call_cannot_hold_the_step_forever(run, monkeypatch):
    monkeypatch.setattr(compile_box, "_MODEL_WATCHDOG_POLL_S", 0.001)
    monkeypatch.setattr(compile_box, "_MODEL_IDLE_TIMEOUT_S", 0.001)
    monkeypatch.setattr(compile_box, "_STALL_INTERRUPT_DEADLINE_S", 0.01)
    monkeypatch.setattr(compile_box.destream, "model_idle_floor", lambda: 0)

    class HungInterrupt(Client):
        async def receive_messages(self):
            await asyncio.Future()
            yield result()

        async def interrupt(self):
            self.interrupts += 1
            await asyncio.Future()

    worker = HungInterrupt()
    watchdog = asyncio.create_task(compile_box._model_stall_watchdog(run))
    task = asyncio.create_task(compile_box._execute_compile_step(run, worker, "compile scope"))
    try:
        done, _ = await asyncio.wait({task}, timeout=0.5)
        assert task in done, "watchdog must also bound the interrupt call itself"
        with pytest.raises(compile_box.ModelStallError):
            await task
        assert worker.disconnected and worker.interrupts == 1
        assert run._active_step is None
    finally:
        watchdog.cancel()
        task.cancel()
        await asyncio.gather(watchdog, task, return_exceptions=True)


async def test_watchdog_bounds_worker_that_swallows_cancellation(run, monkeypatch, tmp_path):
    monkeypatch.setattr(compile_box, "_MODEL_WATCHDOG_POLL_S", 0.001)
    monkeypatch.setattr(compile_box, "_WORKER_TEARDOWN_TIMEOUT_S", 0.01)
    monkeypatch.setenv("KBC_BATCH_PLANNER", "model")
    monkeypatch.setattr(compile_box.pi_config, "for_role", lambda *a, **kw: {})
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw/source.md").write_text("synthetic source")
    cancelled, release = asyncio.Event(), asyncio.Event()

    class UnresponsiveWorker(Client):
        returncode = 1

        async def receive_messages(self):
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    cancelled.set()
            yield result()

    worker = UnresponsiveWorker()
    monkeypatch.setattr(compile_box, "create_agent_client", lambda **kw: worker)
    watchdog = asyncio.create_task(compile_box._model_stall_watchdog(run))
    driver = asyncio.create_task(compile_box._run_batch_compile(run, "compile scope"))
    step = None
    try:
        await asyncio.wait_for(cancelled.wait(), 0.5)
        step = run._active_step
        done, _ = await asyncio.wait({driver}, timeout=0.5)
        assert driver in done, "watchdog cancellation must start the teardown deadline before SDK finally"
        await driver
        assert not worker.disconnected
        assert run._active_step is step and step.teardown_failed
        assert run._batch_active and not run._turn_active
        events = drain(run)
        failures = [event for event in events if event["type"] == "error"]
        assert len(failures) == 1
        assert failures[0]["code"] == "worker_teardown_failed"
        assert failures[0]["stage"] == "batch_compile"
        assert not any(event["type"] == "syncArtifacts" for event in events)
        assert not (tmp_path / compile_box.batching.BATCH_PLAN_PATH).exists()
        with pytest.raises(RuntimeError, match="teardown was not confirmed"):
            await compile_box._sync_workspace(run, {})
        with pytest.raises(RuntimeError, match="already owns execution"):
            await compile_box._execute_compile_step(run, Client(), "competing step")
    finally:
        release.set()
        watchdog.cancel()
        driver.cancel()
        await asyncio.gather(watchdog, driver, return_exceptions=True)
        if step and step.task:
            await asyncio.gather(step.task, return_exceptions=True)
    assert worker.disconnected
    assert run._active_step is step and step.teardown_failed


async def test_late_watchdog_failure_cannot_cancel_a_successor_step(run):
    entered, release = asyncio.Event(), asyncio.Event()

    async def hold():
        entered.set()
        await release.wait()

    successor = Client([assistant("successor output"), result()], hold)
    task = asyncio.create_task(compile_box._execute_compile_step(run, successor, "new step"))
    try:
        await asyncio.wait_for(entered.wait(), 0.5)
        # The previous worker's interrupt awaited the SDK while this successor
        # started. Its late failure must only refer to that previous client.
        await compile_box._reap_unrecoverable_turn(run, Client(), "late interrupt failure")
        assert run._turn_active
        assert run._active_step.client is successor
        assert not run._active_step.task.cancelling()
    finally:
        release.set()
        outcome = await asyncio.gather(task, return_exceptions=True)
    assert outcome == ["successor output"]


async def test_planner_result_has_step_semantics(run, monkeypatch):
    monkeypatch.setenv("KBC_BATCH_PLANNER", "model")
    owner = run.client

    async def check_owner():
        assert run.client is owner

    worker = Client([assistant("planner output"), result()], check_owner)
    monkeypatch.setattr(compile_box, "create_agent_client", lambda **kw: worker)
    monkeypatch.setattr(compile_box.pi_config, "for_role", lambda *a, **kw: {})
    inventory = [{"path": "source.md", "bytes": 10, "effective": 10}]
    plan = await compile_box._plan_batches(run, inventory)
    assert plan["batches"]
    assert run.client is owner and worker.disconnected
    assert run._turn_text == ["owner reply"]
    assert run._active_step is None
    assert not any(e["type"] in {"turn_done", "syncArtifacts"} for e in drain(run))


async def test_connect_failure_releases_step_without_touching_owner(run):
    class FailedConnect(Client):
        async def connect(self):
            raise AgentTransportError("fixture connection failure")

    worker = FailedConnect()
    with pytest.raises(AgentTransportError):
        await compile_box._execute_compile_step(run, worker, "compile scope")
    assert worker.disconnected and run._active_step is None
    assert not run.client.disconnected and not run._turn_active


async def test_unconfirmed_teardown_blocks_rebuild_and_new_messages(run, monkeypatch):
    class BrokenClose(Client):
        async def disconnect(self):
            raise AgentTransportError("fixture teardown failure")

    worker = BrokenClose([result()])
    creations = []

    def create(*a, **kw):
        creations.append(worker)
        return worker

    monkeypatch.setattr(compile_box, "_compile_session_client", create)
    with pytest.raises(RuntimeError, match="teardown was not confirmed"):
        await compile_box._drive_batch_session(run, "compile scope", "fixture")
    assert len(creations) == 1
    assert run._active_step.client is worker and run._active_step.teardown_failed
    assert not run._turn_active
    run.connected.set()
    response = await compile_box._await_session_live(run)
    assert response.status == 409
    with pytest.raises(RuntimeError, match="already owns execution"):
        await compile_box._execute_compile_step(run, Client(), "new scope")
    assert not run.client.disconnected


@pytest.mark.parametrize("ignore_cancel", [False, True])
async def test_hung_teardown_fails_without_releasing_the_workspace(run, monkeypatch, ignore_cancel):
    monkeypatch.setattr(compile_box, "_WORKER_TEARDOWN_TIMEOUT_S", 0.01, raising=False)
    release = asyncio.Event()
    cancelled = asyncio.Event()

    class HungClose(Client):
        async def disconnect(self):
            try:
                await release.wait()
            except asyncio.CancelledError:
                cancelled.set()
                if not ignore_cancel:
                    raise
                await release.wait()
            await super().disconnect()

    worker = HungClose([result()])
    task = asyncio.create_task(compile_box._execute_compile_step(run, worker, "compile scope"))
    try:
        done, _ = await asyncio.wait({task}, timeout=0.5)
        assert task in done, "SDK teardown must hand failure back within its deadline"
        with pytest.raises(RuntimeError, match="teardown was not confirmed") as error:
            await task
        assert compile_box._batch_error_code(error.value) == "worker_teardown_failed"
        await asyncio.wait_for(cancelled.wait(), 0.5)
        assert run._active_step.client is worker and run._active_step.teardown_failed
        with pytest.raises(RuntimeError, match="teardown was not confirmed"):
            await compile_box._sync_workspace(run, {})
        with pytest.raises(RuntimeError, match="already owns execution"):
            await compile_box._execute_compile_step(run, Client(), "competing step")
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
        if run._active_step and run._active_step.task:
            await asyncio.gather(run._active_step.task, return_exceptions=True)


async def test_failed_planner_teardown_does_not_fall_back_or_publish_a_checkpoint(run, monkeypatch, tmp_path):
    monkeypatch.setenv("KBC_BATCH_PLANNER", "model")
    monkeypatch.setattr(compile_box.pi_config, "for_role", lambda *a, **kw: {})
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw/source.md").write_text("synthetic source")

    class BrokenClose(Client):
        async def disconnect(self):
            raise AgentTransportError("fixture stop failed")

    monkeypatch.setattr(compile_box, "create_agent_client", lambda **kw: BrokenClose([result()]))
    await compile_box._run_batch_compile(run, "compile scope")
    events = drain(run)
    failures = [event for event in events if event["type"] == "error"]
    assert len(failures) == 1
    assert failures[0]["code"] == "worker_teardown_failed"
    assert failures[0]["stage"] == "batch_compile"
    assert run._active_step.teardown_failed and run._batch_active
    assert not (tmp_path / compile_box.batching.BATCH_PLAN_PATH).exists()
    assert not any(event["type"] == "syncArtifacts" for event in events)


async def test_each_step_returns_its_own_reply(run, monkeypatch):
    workers = iter([Client([assistant("first"), result()]), Client([assistant("second"), result()])])
    monkeypatch.setattr(compile_box, "_compile_session_client", lambda *a, **kw: next(workers))
    assert await compile_box._drive_batch_session(run, "scope one", "one") == "first"
    assert await compile_box._drive_batch_session(run, "scope two", "two") == "second"
    assert run._turn_text == ["owner reply"]
    assert run._active_step is None


async def test_step_cannot_take_over_an_active_persistent_turn(run):
    run._begin_turn("owner edit")
    worker = Client([result()])
    with pytest.raises(RuntimeError, match="already owns execution"):
        await compile_box._execute_compile_step(run, worker, "compile scope")
    assert run._turn_active
    assert run._last_directive == "owner edit"
    assert not worker.connected
    assert not run.client.disconnected


async def test_batch_with_unconfirmed_teardown_keeps_sync_and_finalization_closed(run, monkeypatch, tmp_path):
    slices = tmp_path / ".kbc-batch-slices"
    slices.mkdir()
    finalized = []

    async def fail_plan(*args):
        run._active_step = compile_box.CompileStep(Client(), teardown_failed=True)
        raise RuntimeError("fixture teardown was not confirmed")

    async def settle(*args):
        finalized.append("settled")

    monkeypatch.setattr(compile_box, "_plan_batches", fail_plan)
    monkeypatch.setattr(compile_box, "_maybe_start_pk", lambda _: finalized.append("pk"))
    monkeypatch.setattr(compile_box, "_set_converge_phase", settle)
    await compile_box._run_batch_compile(run, "compile scope")
    assert run._batch_active and run._active_step.teardown_failed
    assert slices.exists()
    assert finalized == []
    with pytest.raises(RuntimeError, match="teardown was not confirmed"):
        await compile_box._sync_workspace(run, {})
    # A legacy reconnect must not manufacture a fresh artifact/commit event
    # from an uncertain filesystem. Already captured checkpoint frames may replay.
    class Relay:
        async def stream(self, request, replay):
            return replay()

    run.event_relay = Relay()
    run._commit_input_replay = True
    monkeypatch.setattr(compile_box, "RUNS", {run.run_id: run})
    request = SimpleNamespace(match_info={"run_id": run.run_id})
    assert await compile_box.handle_events(request) == []
    checkpoint = {"type": "syncArtifacts", "artifacts": [], "sync_id": "checkpoint"}
    run._pending_sync_events["checkpoint"] = checkpoint
    assert await compile_box.handle_events(request) == [checkpoint]
