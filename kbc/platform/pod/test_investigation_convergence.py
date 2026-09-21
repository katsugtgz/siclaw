import json

import pytest
import compile_box
import review_notes
import selfcheck
from test_finalization import active_unit, consume, make_workspace, run_for


@pytest.mark.asyncio
@pytest.mark.parametrize('notes_per_pass', [1, 2])
async def test_tail_decisions_do_not_replay_unrelated_final_review(tmp_path, monkeypatch, notes_per_pass):
    make_workspace(tmp_path, 1)
    calls, media_calls = [], []

    def decision(number):
        return {
            'title': f'Version {number}', 'question': f'Which version {number} is supported?',
            'ticket_kind': 'model_gap', 'sources': [{'doc': 'raw/source.md', 'quote': 'Frozen source facts'}],
            'current_value': 'unknown', 'affected_pages': ['p00.md'], 'review_action': 'needs_owner',
            'investigation': 'Checked frozen source; no applicability stated.',
            'answer_impact': 'Installation depends on supported version.', 'owner_decision': 'Confirm supported version.',
        }

    async def worker(run, *args, **kwargs):
        unit = active_unit(run)
        calls.append(unit['kind'])
        if unit['kind'] == 'catalog':
            for number, note in enumerate(review_notes.read(run.workdir), 1):
                if note['state'] == 'pending':
                    tool = next(t for t in compile_box._compile_engine_tools(run) if t.name == 'file_ticket')
                    await tool.handler({**decision(number), 'review_id': note['id']})
        return 'Reviewed'

    async def media(run, *args):
        media_calls.append(1)
        run._batch_stage = 'batch_media_verify'
        notes = review_notes.read(run.workdir)
        # Replaying this unchanged stage can discover a second finite issue;
        # two simultaneous issues must also reach the owner without replaying it.
        for number in range(len(notes) + 1, min(2, len(notes) + notes_per_pass) + 1):
            tool = next(t for t in compile_box._compile_engine_tools(run) if t.name == 'file_ticket')
            await tool.handler(decision(number))

    monkeypatch.setattr(compile_box, '_drive_batch_session', worker)
    monkeypatch.setattr(compile_box, '_run_finalization_media', media)
    monkeypatch.setattr(compile_box, '_media_verify_enabled', lambda: False)
    monkeypatch.setattr(compile_box, '_maybe_start_pk', lambda _: False)
    events, saved = await consume(run_for(tmp_path))
    assert any(e.get('commit_input') for e in events)
    assert not any(e['type'] == 'error' for e in events)
    assert calls.count('semantic') == calls.count('introduction') == 1
    assert calls.count('catalog') == 2
    assert len(media_calls) == 1
    tickets = json.loads(saved[selfcheck.CONTRADICTIONS_PATH])
    assert len(tickets) == notes_per_pass
    assert all(n['state'] == 'needs_owner' for n in review_notes.read(str(tmp_path)))
