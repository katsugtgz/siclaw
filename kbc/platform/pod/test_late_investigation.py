import json

import pytest

import compile_box
import review_notes
import selfcheck
from test_finalization import active_unit, consume, make_workspace, run_for


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["ledger", "media"])
async def test_late_owner_decision_reaches_final_catalog(tmp_path, monkeypatch, phase):
    make_workspace(tmp_path, 1)
    page = tmp_path / 'candidate/p00.md'
    if phase == 'ledger':
        page.write_text(page.read_text() + '\n[Required appendix](missing.md)\n')
    catalog_calls = []
    tool_results = []

    async def worker(run, *args, **kwargs):
        if phase == 'ledger' and run._batch_stage == 'batch_ledger':
            if not review_notes.read(run.workdir):
                tool = next(t for t in compile_box._compile_engine_tools(run) if t.name == 'file_ticket')
                tool_results.append(await tool.handler(decision()))
            return 'The missing applicability information needs an owner decision.'
        unit = active_unit(run)
        if unit['kind'] == 'catalog':
            catalog_calls.append(review_notes.read(run.workdir))
            for note in catalog_calls[-1]:
                tool = next(t for t in compile_box._compile_engine_tools(run) if t.name == 'file_ticket')
                await tool.handler({**decision(), 'review_id': note['id']})
        return 'Reviewed assigned scope.'

    def decision():
        return {
            'title': 'Supported version', 'question': 'Which version is supported?',
            'ticket_kind': 'model_gap',
            'sources': [{'doc': 'raw/source.md', 'quote': 'Frozen source facts'}],
            'current_value': 'uncertain', 'affected_pages': ['p00.md'],
            'review_action': 'needs_owner',
            'investigation': 'Checked the frozen source and all candidate applicability sections; no active version is stated.',
            'answer_impact': 'The installation answer needs the supported version.',
            'owner_decision': 'Confirm the supported version.',
        }

    if phase == 'media':
        async def media_repair(run, plan, replies):
            run._batch_stage = 'batch_media_verify'
            if not review_notes.read(run.workdir):
                tool = next(t for t in compile_box._compile_engine_tools(run) if t.name == 'file_ticket')
                tool_results.append(await tool.handler(decision()))
        monkeypatch.setattr(compile_box, '_run_finalization_media', media_repair)

    monkeypatch.setattr(compile_box, '_drive_batch_session', worker)
    monkeypatch.setattr(compile_box, '_media_verify_enabled', lambda: False)
    monkeypatch.setattr(compile_box, '_maybe_start_pk', lambda _: False)
    events, saved = await consume(run_for(tmp_path))
    observation = {
        'catalog_calls': len(catalog_calls),
        'notes_seen_by_catalog': catalog_calls,
        'tool_results': tool_results,
        'commit_input': any(event.get('commit_input') for event in events),
        'final_notes': review_notes.read(str(tmp_path)),
        'owner_ticket_saved': selfcheck.CONTRADICTIONS_PATH in saved,
        'errors': [e for e in events if e['type'] == 'error'],
    }
    print(json.dumps(observation, ensure_ascii=False))
    assert observation['commit_input']
    assert len(catalog_calls) >= 2
    assert observation['owner_ticket_saved'], (
        'A needs_owner decision produced after catalog review was deferred, '
        'but the catalog never reran before committing the compile.'
    )
