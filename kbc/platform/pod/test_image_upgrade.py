"""Image handoff through the real HTTP admission and artifact-ACK boundaries."""
import asyncio
import tempfile
from pathlib import Path
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer
import compile_box


async def fixture(check):
    compile_box.RUNS.clear()
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "candidate").mkdir()
        (root / "candidate/index.md").write_text("# Saved candidate\n")
        run = compile_box.CompileRun("upgrade-run", td, 1)
        run.connected.set()
        run._artifact_ack_required = True
        run._sync_sent = {}
        compile_box.RUNS[run.run_id] = run
        client = TestClient(TestServer(compile_box.build_app()))
        await client.start_server()
        try:
            await check(client, run)
        finally:
            compile_box.RUNS.clear()
            await client.close()


def test_upgrade_waits_for_durable_ack_and_fences_new_work():
    async def check(client, run):
        # Already queued bytes are not a durable receipt: force a fresh ACK.
        await compile_box._sync_workspace(run, run._sync_sent)
        await run.events.get()
        pending = asyncio.create_task(client.post("/prepare-upgrade/upgrade-run", json={}))
        event = await asyncio.wait_for(run.events.get(), 1)
        assert event["sync_id"] and not pending.done()
        denied = await client.post("/message/upgrade-run", json={"message": "do more"})
        assert denied.status == 409
        assert not run._turn_active
        ack = await client.post("/artifacts/ack/upgrade-run", json={"sync_id": event["sync_id"]})
        assert ack.status == 200
        response = await pending
        assert (await response.json())["state"] == "ready"
        assert run._upgrade_draining
        health = await client.get("/health")
        assert (await health.json())["upgrade_ready_run"] == run.run_id
        # Lost ready responses are safe to replay, without another checkpoint.
        repeated = await client.post("/prepare-upgrade/upgrade-run", json={})
        assert (await repeated.json())["state"] == "ready"
        assert run.events.empty()
    asyncio.run(fixture(check))


def test_runtime_idle_is_not_enough_during_model_or_background_work():
    async def check(client, run):
        for flag in ["_turn_active", "_batch_active", "_l1_repair_pending"]:
            setattr(run, flag, True)
            response = await client.post("/prepare-upgrade/upgrade-run", json={})
            assert (await response.json())["state"] == "busy"
            assert not run._upgrade_draining
            setattr(run, flag, False)
        run._upgrade_idle_ready = False
        response = await client.post("/prepare-upgrade/upgrade-run", json={})
        assert (await response.json())["state"] == "busy"
        run._upgrade_idle_ready = True
        for flag in ["_media_task", "_pk_task"]:
            task = asyncio.create_task(asyncio.Event().wait())
            setattr(run, flag, task)
            try:
                response = await client.post("/prepare-upgrade/upgrade-run", json={})
                assert (await response.json())["state"] == "busy"
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                setattr(run, flag, None)
        assert run.events.empty()
    asyncio.run(fixture(check))


def test_upgrade_defers_for_test_sessions_and_missing_ack_support():
    async def check(client, run):
        test = compile_box.TestRun("test", run.workdir, run.run_id, "snapshot")
        compile_box.TEST_SESSIONS[test.tid] = test
        try:
            response = await client.post("/prepare-upgrade/upgrade-run", json={})
            assert (await response.json())["state"] == "busy"
        finally:
            compile_box.TEST_SESSIONS.pop(test.tid)
        run._artifact_ack_required = False
        response = await client.post("/prepare-upgrade/upgrade-run", json={})
        assert (await response.json())["state"] == "unsupported"
        assert not run._upgrade_draining
    asyncio.run(fixture(check))


def test_unsyncable_candidate_prevents_retirement_and_releases_admission():
    async def check(client, run):
        (Path(run.workdir) / "candidate/large.md").write_text("x" * (compile_box.MAX_SYNC_FILE_BYTES + 1))
        response = await client.post("/prepare-upgrade/upgrade-run", json={})
        assert response.status == 503
        assert not run._upgrade_draining and not run._upgrade_ready
        assert run.events.empty()
    asyncio.run(fixture(check))


def test_failed_checkpoint_does_not_leave_the_old_session_fenced():
    async def check(client, run):
        async def no_ack(*args, **kwargs):
            raise TimeoutError("consumer unavailable")
        with patch.object(compile_box, "_sync_workspace", no_ack):
            response = await client.post("/prepare-upgrade/upgrade-run", json={})
            assert response.status == 503
        assert not run._upgrade_draining and not run._upgrade_ready
        health = await client.get("/health")
        assert (await health.json())["upgrade_ready_run"] is None
    asyncio.run(fixture(check))


def test_finished_operation_can_retire_without_writing_its_terminal_attempt():
    async def check(client, run):
        response = await client.post("/prepare-upgrade/upgrade-run", json={"persist_workspace": False})
        assert (await response.json())["state"] == "ready"
        assert run._upgrade_draining and run.events.empty()
    asyncio.run(fixture(check))
