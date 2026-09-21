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
