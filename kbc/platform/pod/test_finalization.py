import asyncio
import json
import shutil
from pathlib import Path

import pytest
import batching
import compile_box
import finalization


def make_workspace(root, count=13):
    for directory in ('raw', 'authoring', 'candidate'):
        (root / directory).mkdir()
    (root / 'raw/source.md').write_text('Frozen source facts')
    (root / 'authoring/manifest.yaml').write_text('fingerprint: frozen-fixture\n')
    for i in range(count):
        (root / f'candidate/p{i:02d}.md').write_text(
            f'---\ntype: concept\ntitle: Unique topic {i}\nlabels:\n  - facet: topic\n    value: topic-{i}\n'
            f'sources:\n  - resource: raw/source.md\n---\n# Topic {i}\n\nFact {i}.\n')
    (root / 'candidate/index.md').write_text("---\nokf_version: '0.2'\n---\n# Index\n" +
        '\n'.join(f'- [Topic {i}](p{i:02d}.md)' for i in range(count)))
    plan = {'version': 1, 'phase': 'final', 'mode': 'flat', 'planner': 'code', 'budget': 1000,
            'batches': [{'id': 'b01', 'sources': ['source.md'], 'status': 'done'}]}
    batching.seal_checkpoint(plan)
    (root / batching.BATCH_PLAN_PATH).write_text(batching.dump_json(plan))
    return plan


def run_for(root):
    run = compile_box.CompileRun('fixture', str(root), 1)
    run._artifact_ack_required = True
    run._sync_sent = compile_box._workspace_sync_cursor(str(root))
    return run


def active_unit(run):
    ledger = run._finalization_plan['finalization']
    return next(u for u in ledger['units'] if u['id'] == ledger['current_unit'])


async def consume(run, consumer=None, on_event=None):
    if consumer is None:
        consumer = {a['path']: a['content'] for a in compile_box._collect_workspace_artifacts(run.workdir)}
    events = []
    task = asyncio.create_task(compile_box._run_batch_compile(run, 'resume'))
    getter = None
    try:
        # Bound a broken fixture without imposing a five-second performance
        # requirement on multi-unit persistence under shared build load.
        async with asyncio.timeout(30):
            while not task.done() or not run.events.empty():
                getter = asyncio.create_task(run.events.get())
                done, _ = await asyncio.wait({getter, task}, return_when=asyncio.FIRST_COMPLETED)
                if getter not in done and run.events.empty():
                    getter.cancel()
                    await asyncio.gather(getter, return_exceptions=True)
                    break
                event = await getter
                events.append(event)
                if on_event:
                    await on_event(event, task)
                if event['type'] == 'syncArtifacts':
                    for artifact in event['artifacts']:
                        if artifact.get('deleted'):
                            consumer.pop(artifact['path'], None)
                        else:
                            consumer[artifact['path']] = artifact['content']
                    if event.get('sync_id'):
                        run._pending_sync_acks[event['sync_id']].set_result(None)
            await task
    finally:
        if getter and not getter.done(): getter.cancel()
        if not task.done(): task.cancel()
        await asyncio.gather(task, *([getter] if getter else []), return_exceptions=True)
    return events, consumer


@pytest.fixture
def fast_tail(monkeypatch):
    async def ledger(*args): pass
    monkeypatch.setattr(compile_box, '_run_ledger_repairs', ledger)
    monkeypatch.setattr(compile_box, '_media_verify_enabled', lambda: False)
    monkeypatch.setattr(compile_box, '_maybe_start_pk', lambda _: False)


async def test_resume_skips_completed_units_and_preserves_failed_edits(tmp_path, monkeypatch, fast_tail):
    make_workspace(tmp_path)
    calls = []
    failed = False
    async def worker(run, directive, label, **kwargs):
        nonlocal failed
        unit = active_unit(run)
        calls.append(unit['id'])
        if unit['kind'] == 'semantic' and len(calls) == 2 and not failed:
            failed = True
            path = Path(run.workdir) / 'candidate' / unit['targets'][0]
            path.write_text(path.read_text() + '\nPartial final review edit.\n')
            raise compile_box.ModelStallError('fixture interruption')
        return 'Reviewed assigned scope.'
    monkeypatch.setattr(compile_box, '_drive_batch_session', worker)
    first, saved = await consume(run_for(tmp_path))
    first_unit = calls[0]
    assert any(e.get('code') == 'model_stall' for e in first)
    assert not any(e.get('commit_input') for e in first)
    assert any('Partial final review edit' in body for body in saved.values())
    restored = tmp_path / 'restored'
    restored.mkdir()
    shutil.copytree(tmp_path / 'raw', restored / 'raw')
    for name, body in saved.items():
        path = restored / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    second, _ = await consume(run_for(restored), saved)
    assert calls.count(first_unit) == 1, 'completed unchanged responsibility reran'
    assert any(e.get('commit_input') for e in second)
    assert not any(e['type'] == 'error' for e in second)
    plan = json.loads((restored / batching.BATCH_PLAN_PATH).read_text())
    assert plan['phase'] == 'complete' and plan['finalization']['stage'] == 'complete'


async def test_call_budget_splits_without_losing_pages(tmp_path, monkeypatch, fast_tail):
    make_workspace(tmp_path)
    reviewed = set()
    async def worker(run, *args, **kwargs):
        unit = active_unit(run)
        if unit['kind'] == 'semantic':
            if len(unit['targets']) > 2:
                raise compile_box.ModelCallBudgetExceeded('fixture bound')
            reviewed.update(unit['targets'])
        return 'Scope checked.'
    monkeypatch.setattr(compile_box, '_drive_batch_session', worker)
    events, _ = await consume(run_for(tmp_path))
    assert any(e.get('commit_input') for e in events)
    assert reviewed == {f'p{i:02d}.md' for i in range(13)}
    ledger = json.loads((tmp_path / batching.BATCH_PLAN_PATH).read_text())['finalization']
    assert ledger['split_count'] > 0
    finalization.validate(ledger)
    assert not any(e['type'] == 'error' for e in events)


async def test_regrouped_orphans_resume_after_repeated_splits(tmp_path, monkeypatch, fast_tail):
    make_workspace(tmp_path, 4)
    index = tmp_path / 'candidate/index.md'
    index.write_text("---\nokf_version: '0.2'\n---\n# Index\n")

    async def interrupted_worker(run, *args, **kwargs):
        unit = active_unit(run)
        if unit['kind'] == 'orphans':
            if len(unit['targets']) == 4:
                index.write_text(index.read_text() + '\n- [Topic 0](p00.md)\n')
                raise compile_box.ModelCallBudgetExceeded('partial routing edit')
            if len(unit['targets']) == 3:
                raise compile_box.ModelCallBudgetExceeded('regroup remaining orphans')
            if len(unit['targets']) == 1:
                raise compile_box.ModelStallError('interrupted after second split')
        # Bounded quality work may retain unresolved routing for a later pass.
        return 'Unresolved routing remains recorded.'

    monkeypatch.setattr(compile_box, '_drive_batch_session', interrupted_worker)
    events, saved = await consume(run_for(tmp_path))
    assert any(e.get('code') == 'model_stall' for e in events)
    assert not any(e.get('commit_input') for e in events)
    finalization.validate(json.loads(saved[batching.BATCH_PLAN_PATH])['finalization'])

    restored = tmp_path / 'restored'
    shutil.copytree(tmp_path / 'raw', restored / 'raw')
    for name, body in saved.items():
        path = restored / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    compile_box._load_batch_plan(run_for(restored))

    async def resumed_worker(run, *args, **kwargs):
        unit = active_unit(run)
        if unit['kind'] == 'orphans':
            path = Path(run.workdir) / 'candidate/index.md'
            path.write_text(path.read_text() + ''.join(
                f'\n- [Recovered topic]({p})\n' for p in unit['targets']))
        return 'Reviewed assigned scope.'

    monkeypatch.setattr(compile_box, '_drive_batch_session', resumed_worker)
    events, saved = await consume(run_for(restored), saved)
    assert any(e.get('commit_input') for e in events)
    assert not any(e['type'] == 'error' for e in events)
    plan = json.loads(saved[batching.BATCH_PLAN_PATH])
    assert plan['phase'] == 'complete'
    finalization.validate(plan['finalization'])


def test_legacy_split_receipts_keep_their_identity(tmp_path):
    plan = make_workspace(tmp_path, 4)
    ledger = finalization.ensure(plan, str(tmp_path))
    parent = finalization.add(ledger, 'orphans', ['p00.md', 'p01.md', 'p02.md', 'p03.md'])
    # Older producers keyed split children by targets only.
    children = [finalization.add(ledger, 'orphans', group)
                for group in (['p00.md', 'p01.md'], ['p02.md', 'p03.md'])]
    for child in children:
        child['parent'] = parent['id']
    parent.update(status='split', children=[c['id'] for c in children])
    finalization.complete(children[1], finalization.snapshot(str(tmp_path)), finalization.digest('context'), set(), 'Reviewed.')
    saved = json.loads(json.dumps(plan))
    ledger = finalization.ensure(saved, str(tmp_path))
    assert ledger['units'] == plan['finalization']['units']
    assert finalization.add(ledger, 'orphans', children[1]['targets'], parent=parent['id']) == children[1]
    # A later root responsibility cannot reuse a child still owned by that split.
    root = finalization.add(ledger, 'orphans', children[1]['targets'])
    assert root['id'] != children[1]['id'] and not root.get('parent')
    finalization.split(ledger, root)
    finalization.validate(ledger)


async def test_save_ack_precedes_next_unit_and_commit(tmp_path, monkeypatch, fast_tail):
    make_workspace(tmp_path, 1)
    calls, held = [], []
    async def worker(*args, **kwargs):
        calls.append('model')
        return 'Reviewed.'
    monkeypatch.setattr(compile_box, '_drive_batch_session', worker)
    async def before_ack(event, task):
        if event['type'] == 'syncArtifacts' and event.get('completed_checkpoint_id') and not held:
            n = len(calls)
            await asyncio.sleep(.02)
            assert len(calls) == n and not task.done()
            assert not event.get('commit_input')
            held.append(event['completed_checkpoint_id'])
    events, _ = await consume(run_for(tmp_path), on_event=before_ack)
    assert held and any(e.get('commit_input') for e in events)


async def test_single_page_budget_exhaustion_is_not_done(tmp_path, monkeypatch, fast_tail):
    make_workspace(tmp_path, 1)
    async def worker(*args, **kwargs):
        raise compile_box.ModelCallBudgetExceeded('fixture bound')
    monkeypatch.setattr(compile_box, '_drive_batch_session', worker)
    events, saved = await consume(run_for(tmp_path))
    assert any(e.get('code') == 'model_call_budget_exceeded' for e in events)
    assert not any(e.get('commit_input') for e in events)
    ledger = json.loads(saved[batching.BATCH_PLAN_PATH])['finalization']
    assert all(u['status'] != 'done' for u in ledger['units'])


def test_dependencies_and_producer_stamps(tmp_path):
    plan = make_workspace(tmp_path, 3)
    ledger = finalization.ensure(plan, str(tmp_path))
    a = finalization.add(ledger, 'semantic', ['p00.md'])
    b = finalization.add(ledger, 'semantic', ['p02.md'])
    before = finalization.snapshot(str(tmp_path))
    finalization.complete(a, before, 'context', {'p01.md'}, 'reviewed')
    finalization.complete(b, before, 'context', set(), 'reviewed')
    path = tmp_path / 'candidate/p01.md'
    path.write_text(path.read_text() + '\nChanged fact.\n')
    after = finalization.snapshot(str(tmp_path))
    assert not finalization.valid(a, after, 'context')
    assert finalization.valid(b, after, 'context')
    assert not finalization.valid(b, after, 'owner-ruling-changed')
    text = (tmp_path / 'candidate/p02.md').read_text()
    stamped = text.replace('type: concept', "generated:\n  at: '2026-09-20T01:00:00Z'\ntype: concept")
    assert finalization.page_fingerprint(text) == finalization.page_fingerprint(stamped)


def test_invalid_ledger_and_changed_input(tmp_path):
    plan = make_workspace(tmp_path, 1)
    ledger = finalization.ensure(plan, str(tmp_path))
    unit = finalization.add(ledger, 'semantic', ['p00.md'])
    unit.update(status='split', children=[unit['id'], 'missing'])
    with pytest.raises(finalization.FinalizationError):
        finalization.ensure(plan, str(tmp_path))
    plan.pop('finalization')
    finalization.ensure(plan, str(tmp_path))
    (tmp_path / 'authoring/manifest.yaml').write_text('fingerprint: different\n')
    with pytest.raises(finalization.FinalizationError, match='input changed'):
        finalization.ensure(plan, str(tmp_path))


async def test_later_edits_recheck_dependencies_and_a_cycle_pauses(tmp_path, monkeypatch, fast_tail):
    make_workspace(tmp_path, 2)
    monkeypatch.setattr(finalization, 'MAX_PAGES', 1)
    # pack's default is bound at definition, so seed two explicit responsibilities.
    plan = json.loads((tmp_path / batching.BATCH_PLAN_PATH).read_text())
    ledger = finalization.ensure(plan, str(tmp_path))
    finalization.add(ledger, 'semantic', ['p00.md'])
    finalization.add(ledger, 'semantic', ['p01.md'])
    batching.seal_checkpoint(plan)
    (tmp_path / batching.BATCH_PLAN_PATH).write_text(batching.dump_json(plan))
    touched = 0
    async def worker(run, *args, **kwargs):
        nonlocal touched
        unit = active_unit(run)
        if unit['kind'] == 'semantic':
            # Both reviews actually consulted the same mutable dependency.
            run._finalization_reads.update({'p00.md', 'p01.md'})
            path = Path(run.workdir) / 'candidate/p00.md'
            path.write_text(path.read_text() + f'\nRevision {touched}.\n')
            touched += 1
        return 'Reviewed current content.'
    monkeypatch.setattr(compile_box, '_drive_batch_session', worker)
    events, saved = await consume(run_for(tmp_path))
    assert 2 < touched <= 2 * finalization.MAX_PASSES
    assert any(e.get('code') == 'finalization_not_converged' for e in events)
    assert not any(e.get('commit_input') for e in events)
    saved_plan = json.loads(saved[batching.BATCH_PLAN_PATH])
    assert saved_plan['finalization']['stage'] == 'paused'
    assert saved_plan['finalization']['passes'] == finalization.MAX_PASSES
    assert saved_plan['finalization_progress']['pending'] > 0


async def test_quality_edit_rechecks_only_affected_review_and_notes_apply_once(tmp_path, monkeypatch, fast_tail):
    make_workspace(tmp_path, 2)
    plan = json.loads((tmp_path / batching.BATCH_PLAN_PATH).read_text())
    ledger = finalization.ensure(plan, str(tmp_path))
    a = finalization.add(ledger, 'semantic', ['p00.md'])['id']
    b = finalization.add(ledger, 'semantic', ['p01.md'])['id']
    batching.seal_checkpoint(plan)
    (tmp_path / batching.BATCH_PLAN_PATH).write_text(batching.dump_json(plan))
    calls = []
    changed = False
    run = run_for(tmp_path)
    run._batch_notes.append('Keep source uncertainty visible.')
    async def worker(run, *args, **kwargs):
        unit = active_unit(run)
        calls.append((unit['id'], unit['kind']))
        return 'Reviewed.'
    async def quality(run, replies):
        nonlocal changed
        if not changed:
            changed = True
            path = Path(run.workdir) / 'candidate/p00.md'
            path.write_text(path.read_text() + '\nCorrected after source check.\n')
    monkeypatch.setattr(compile_box, '_drive_batch_session', worker)
    monkeypatch.setattr(compile_box, '_run_ledger_repairs', quality)
    events, _ = await consume(run)
    assert [i for i, k in calls].count(a) == 2
    assert [i for i, k in calls].count(b) == 1
    assert sum(k == 'notes' for i, k in calls) == 1
    assert any(e.get('commit_input') for e in events)


async def test_commit_checkpoint_rejects_changed_reviewed_content(tmp_path, monkeypatch, fast_tail):
    make_workspace(tmp_path, 1)
    calls = []
    async def worker(*args, **kwargs):
        calls.append('review')
        return 'Reviewed.'
    monkeypatch.setattr(compile_box, '_drive_batch_session', worker)
    events, _ = await consume(run_for(tmp_path))
    assert any(e.get('commit_input') for e in events)
    plan = json.loads((tmp_path / batching.BATCH_PLAN_PATH).read_text())
    plan['phase'] = 'commit'
    batching.seal_checkpoint(plan)
    (tmp_path / batching.BATCH_PLAN_PATH).write_text(batching.dump_json(plan))
    path = tmp_path / 'candidate/p00.md'
    path.write_text(path.read_text() + '\nUnreviewed mutation.\n')
    calls.clear()
    events, _ = await consume(run_for(tmp_path))
    assert any(e.get('code') == 'plan_integrity' for e in events)
    assert not any(e.get('commit_input') for e in events) and calls == []


async def test_finalization_tracks_global_reads_and_protects_machine_ledger(tmp_path, monkeypatch):
    from types import SimpleNamespace
    make_workspace(tmp_path, 2)
    run = run_for(tmp_path)
    run._finalization_plan = {'finalization': {}}
    run._finalization_reads = set()
    monkeypatch.setattr(compile_box.pi_config, 'for_role', lambda *a, **kw: {})
    monkeypatch.setattr(compile_box, 'create_agent_client', lambda **kw: SimpleNamespace(**kw))
    client = compile_box._compile_session_client(run, str(tmp_path), 'fixture prompt', 'session')
    tools = {tool.name: tool for tool in client.tools}
    await tools['Read'].handler({'file_path': str(tmp_path / 'candidate/p00.md')})
    assert 'p00.md' in run._finalization_reads
    await tools['Read'].handler({'file_path': str(tmp_path / 'raw/source.md')})
    await tools['Grep'].handler({'path': str(tmp_path / 'candidate'), 'pattern': 'no-such-fact'})
    assert {'p00.md', 'p01.md'} <= run._finalization_reads
    with pytest.raises(PermissionError, match='machine-owned'):
        await tools['Write'].handler({'file_path': str(tmp_path / batching.BATCH_PLAN_PATH), 'content': '{}'})


async def test_final_commit_does_not_acknowledge_unhandled_new_guidance(tmp_path, monkeypatch, fast_tail):
    make_workspace(tmp_path, 1)
    run = run_for(tmp_path)
    run._batch_active = True
    run._batch_notes_closed = True
    with pytest.raises(compile_box.CommandRejected, match='committing'):
        await compile_box._dispatch_authoring_turn(run, 'new owner instruction')
    assert run._batch_notes == []


def test_introduction_output_is_pinned_without_invalidating_unrelated_content(tmp_path):
    plan = make_workspace(tmp_path, 1)
    ledger = finalization.ensure(plan, str(tmp_path))
    intro = finalization.add(ledger, "introduction", [])
    page = finalization.add(ledger, "semantic", ["p00.md"])
    before = finalization.snapshot(str(tmp_path))
    context = finalization.digest("context")
    finalization.complete(intro, before, context, set(), "reported")
    finalization.complete(page, before, context, {"p00.md"}, "checked")
    (tmp_path / "candidate/.library-introduction.json").write_text('{"summary":"Changed routing"}')
    after = finalization.snapshot(str(tmp_path))
    assert not finalization.valid(intro, after, context)
    assert finalization.valid(page, after, context)
    assert finalization.page_fingerprint("---\n1: value\nname: text\n---\n# malformed keys")


def test_semantic_receipt_detects_changed_claim_attribution():
    header = "---\ntitle: Page\nsources:\n  - id: a\n    resource: raw/a.md\n  - id: b\n    resource: raw/b.md\n---\n"
    a = header + '<!-- okf:evidence {"id":"claim","sources":["a"]} -->\nThe supported claim.\n'
    b = a.replace('["a"]', '["b"]')
    assert finalization.page_fingerprint(a) != finalization.page_fingerprint(b)
    rebound = a.replace('id: a', 'id: rebound').replace('["a"]', '["rebound"]')
    assert finalization.page_fingerprint(a) == finalization.page_fingerprint(rebound)
    page_level = header + 'The supported claim.\n'
    generated = header + '<!-- okf:evidence {"id":"generated","sources":["a","b"]} -->\nThe supported claim.\n'
    assert finalization.page_fingerprint(page_level) == finalization.page_fingerprint(generated)


def test_investigation_context_ignores_timestamp_but_tracks_decision(tmp_path):
    authoring = tmp_path / 'authoring'
    authoring.mkdir()
    notes = authoring / 'REVIEW_NOTES.json'
    row = {'id': 'review', 'state': 'pending', 'investigation': 'checked source', 'updated_at': 'old'}
    notes.write_text(json.dumps([row]))
    before = finalization.context_identity(str(tmp_path))
    notes.write_text(json.dumps([{**row, 'updated_at': 'new'}]))
    assert finalization.context_identity(str(tmp_path)) == before
    notes.write_text(json.dumps([{**row, 'owner_decision': 'choose version'}]))
    assert finalization.context_identity(str(tmp_path)) != before
