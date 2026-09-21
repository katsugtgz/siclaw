import asyncio
from pathlib import Path
import pytest
import compile_box
import mediaverify


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['oversize', 'corrupt_cache', 'permission', 'cache_permission'])
async def test_deterministic_checkpoint_waits_for_repair_then_requires_ack(tmp_path, monkeypatch, failure):
    (tmp_path / 'candidate').mkdir()
    (tmp_path / 'authoring').mkdir()
    if failure in {'corrupt_cache', 'cache_permission'}:
        broken = tmp_path / mediaverify.TRANSCRIPTS_PATH
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text('{broken' if failure == 'corrupt_cache' else 'locked')
        repaired = '{}'
    else:
        broken = tmp_path / 'candidate/page.md'
        broken.write_text('x' * (compile_box.MAX_SYNC_FILE_BYTES + 1) if failure == 'oversize' else 'locked')
        repaired = '# Retained page\n'
    if failure in {'permission', 'cache_permission'}:
        original_read = Path.read_text
        def read(path, *args, **kwargs):
            if path == broken and path.stat().st_size == len('locked'):
                raise PermissionError(13, 'access denied')
            return original_read(path, *args, **kwargs)
        monkeypatch.setattr(Path, 'read_text', read)
    run = compile_box.CompileRun('checkpoint', str(tmp_path), 1)
    run._artifact_ack_required = True
    sync_calls = []
    original_sync = compile_box._sync_workspace
    async def sync(*args, **kwargs):
        sync_calls.append(1)
        return await original_sync(*args, **kwargs)
    monkeypatch.setattr(compile_box, '_sync_workspace', sync)
    paused = asyncio.Event()
    resume = asyncio.Event()
    original_sleep = asyncio.sleep
    ticks = []
    async def sleep(delay):
        if delay == 5:
            ticks.append(1)
            if len(ticks) == 3:
                paused.set()
                await resume.wait()
            else:
                await original_sleep(0)
        else:
            await original_sleep(delay)
    monkeypatch.setattr(compile_box.asyncio, 'sleep', sleep)
    task = asyncio.create_task(compile_box._checkpoint_failed_workspace(run, {}))
    try:
        await asyncio.wait_for(paused.wait(), 2)
        assert len(sync_calls) == 1, 'unchanged invalid artifacts must not be blindly resubmitted'
        events = []
        while not run.events.empty(): events.append(run.events.get_nowait())
        assert any(e['type'] == 'error' and e.get('recoverable') and e.get('code') == 'workspace_checkpoint_blocked' for e in events)
        assert not any(e['type'] in {'end', 'done', 'turn_done'} for e in events)
        assert broken.exists() and not task.done()
        broken.write_text(repaired)
        resume.set()
        while True:
            event = await asyncio.wait_for(run.events.get(), 2)
            if event['type'] == 'syncArtifacts':
                assert not task.done()
                run._pending_sync_acks[event['sync_id']].set_result(None)
                break
        await asyncio.wait_for(task, 2)
        assert not getattr(run, '_checkpoint_blocked', None)
        assert len(sync_calls) == 2
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_temporary_read_failure_retries_without_waiting_for_file_change(tmp_path, monkeypatch):
    (tmp_path / 'candidate').mkdir()
    page = tmp_path / 'candidate/page.md'
    page.write_text('# Page')
    original_read = Path.read_text
    failed = []
    def read(path, *args, **kwargs):
        if path == page and not failed:
            failed.append(True)
            raise OSError(5, 'temporary I/O failure')
        return original_read(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', read)
    async def sleep(_): pass
    monkeypatch.setattr(compile_box.asyncio, 'sleep', sleep)
    run = compile_box.CompileRun('read-retry', str(tmp_path), 1)
    await asyncio.wait_for(compile_box._checkpoint_failed_workspace(run, {}), 2)
    assert failed and not getattr(run, '_checkpoint_blocked', None)
    events = []
    while not run.events.empty(): events.append(run.events.get_nowait())
    assert any(e['type'] == 'syncArtifacts' for e in events)
    assert not any(e.get('code') == 'workspace_checkpoint_blocked' for e in events)


def test_mixed_invalid_and_unreadable_artifacts_are_not_retryable(tmp_path, monkeypatch):
    candidate = tmp_path / 'candidate'
    candidate.mkdir()
    large = candidate / 'large.md'
    large.write_text('x' * (compile_box.MAX_SYNC_FILE_BYTES + 1))
    bad = candidate / 'io.md'
    bad.write_text('# Page')
    original = Path.read_text
    def read(path, *args, **kwargs):
        if path == bad: raise OSError(5, 'I/O failed')
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', read)
    with pytest.raises(compile_box.WorkspaceArtifactError) as caught:
        compile_box._collect_workspace_artifacts(str(tmp_path), strict=True)
    assert caught.value.retryable is False


@pytest.mark.asyncio
async def test_persistent_io_reports_blocked_then_recovers_without_metadata_change(tmp_path, monkeypatch):
    (tmp_path / 'candidate').mkdir()
    page = tmp_path / 'candidate/page.md'
    page.write_text('# Page')
    original = Path.read_text
    initial_stat = page.stat()
    run = compile_box.CompileRun('persistent-io', str(tmp_path), 1)
    attempts, blocked_at_probe, delays = [], [], []
    def read(path, *args, **kwargs):
        if path == page:
            attempts.append(1)
            if len(attempts) <= 3: raise OSError(5, 'persistent I/O failed')
            blocked_at_probe.append(bool(getattr(run, '_checkpoint_blocked', None)))
            assert page.stat().st_mtime_ns == initial_stat.st_mtime_ns
        return original(path, *args, **kwargs)
    async def sleep(delay): delays.append(delay)
    monkeypatch.setattr(Path, 'read_text', read)
    monkeypatch.setattr(compile_box.asyncio, 'sleep', sleep)
    await asyncio.wait_for(compile_box._checkpoint_failed_workspace(run, {}), 2)
    events = []
    while not run.events.empty(): events.append(run.events.get_nowait())
    assert blocked_at_probe[0]
    assert sum(delays) >= 60
    assert any(e.get('code') == 'workspace_checkpoint_blocked' and e.get('recoverable') for e in events)
    assert not getattr(run, '_checkpoint_blocked', None)


@pytest.mark.asyncio
@pytest.mark.parametrize('action', [None, 'compile.refresh_domain'])
async def test_blocked_checkpoint_rejects_owner_turn_before_mutation(tmp_path, monkeypatch, action):
    run = compile_box.CompileRun('blocked-message', str(tmp_path), 1)
    run._batch_active = True
    run._checkpoint_blocked = {'code': 'workspace_checkpoint_blocked'}
    def capture(*args): raise AssertionError('blocked turn must not alter authoring intent')
    monkeypatch.setattr(compile_box, '_capture_brief', capture)
    with pytest.raises(compile_box.CommandRejected, match='checkpoint|保存'):
        await compile_box._dispatch_authoring_turn(run, 'Please inspect the failure.', action)
    assert run._batch_notes == []
    assert run._batch_active


def test_blocked_checkpoint_rejects_command_preparation(tmp_path):
    run = compile_box.CompileRun('blocked-command', str(tmp_path), 1)
    run._checkpoint_blocked = {'code': 'workspace_checkpoint_blocked'}
    with pytest.raises(compile_box.CommandRejected, match='checkpoint|保存') as caught:
        compile_box._prepare_command(run, {'action': 'compile.refresh_domain', 'parameters': {'brief': {'note': 'new intent'}}})
    assert caught.value.status == 409
    assert not (tmp_path / 'authoring/BRIEF.json').exists()


@pytest.mark.asyncio
async def test_persistent_failure_remains_blocked_without_repeated_notices(tmp_path, monkeypatch):
    run = compile_box.CompileRun('persistent-failure', str(tmp_path), 1)
    calls, ticks = [], []
    parked = asyncio.Event()
    release = asyncio.Event()
    async def fail(*args, **kwargs):
        calls.append(1)
        raise compile_box.WorkspaceArtifactError('storage unreadable', retryable=True)
    async def sleep(delay):
        ticks.append(delay)
        if len(ticks) == 26:
            parked.set()
            await release.wait()
    monkeypatch.setattr(compile_box, '_sync_workspace', fail)
    monkeypatch.setattr(compile_box.asyncio, 'sleep', sleep)
    task = asyncio.create_task(compile_box._checkpoint_failed_workspace(run, {}))
    try:
        await asyncio.wait_for(parked.wait(), 2)
        assert len(calls) == 4  # Three fast attempts, then a bounded periodic probe.
        assert run._checkpoint_blocked['retry_mode'] == 'periodic_probe'
        events = []
        while not run.events.empty(): events.append(run.events.get_nowait())
        assert sum(e.get('code') == 'workspace_checkpoint_blocked' for e in events) == 1
        assert not any(e['type'] in {'done', 'end', 'turn_done'} for e in events)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
