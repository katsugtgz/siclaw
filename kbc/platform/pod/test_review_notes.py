import json
from pathlib import Path

import pytest
import compile_box
import review_notes
import selfcheck


def args(**extra):
    return dict(title="Active version", question="Which version is supported?", ticket_kind="model_gap",
                sources=[{"doc": "raw/spec.md", "quote": "Version A or B"}], current_value="uncertain",
                affected_pages=["guide.md"], **extra)


def decision(**extra):
    return args(review_action="needs_owner", investigation="Read both applicability sections; no active version is stated.",
                answer_impact="Which version should users install?", owner_decision="Confirm the active version.", **extra)


async def call(run, **values):
    tool = next(t for t in compile_box._compile_engine_tools(run) if t.name == "file_ticket")
    return await tool.handler(values)


@pytest.mark.asyncio
async def test_investigate_then_escalate_and_reword_preserves_owner_state(tmp_path):
    run = compile_box.CompileRun("investigate", str(tmp_path), 1)
    result = await call(run, **args())
    assert "no owner ticket" in result
    assert not (tmp_path / selfcheck.CONTRADICTIONS_PATH).exists()
    note = review_notes.read(str(tmp_path))[0]
    assert note["state"] == "pending"
    assert "Before escalating" in await call(run, **args(review_action="needs_owner", review_id=note["id"]))
    await call(run, **decision(review_id=note["id"]))
    path = tmp_path / selfcheck.CONTRADICTIONS_PATH
    tickets = json.loads(path.read_text())
    assert len(tickets) == 1 and tickets[0]["escalation"]["answer_impact"]
    tickets[0].update(status="resolved", answer="Owner selected A", agent_report={"note": "applied"})
    path.write_text(json.dumps(tickets))
    changed = decision(review_id=note["id"])
    changed["question"] = "What version is active for new installs?"
    await call(run, **changed)
    updated = json.loads(path.read_text())
    assert len(updated) == 1 and updated[0]["id"] == tickets[0]["id"]
    assert updated[0]["answer"] == "Owner selected A" and updated[0]["agent_report"] == {"note": "applied"}
    assert selfcheck.normalize_contradictions_file(str(tmp_path)) == (0, None)
    assert "existing ruling" in await call(run, **args(review_action="resolved", review_id=note["id"], investigation="Read more evidence"))


@pytest.mark.asyncio
async def test_batch_defers_owner_until_final_and_can_resolve_without_ticket(tmp_path):
    run = compile_box.CompileRun("batch", str(tmp_path), 1)
    run._batch_active = True
    run._batch_stage = "batch_map"
    await call(run, **decision())
    note = review_notes.read(str(tmp_path))[0]
    assert note["state"] == "pending" and not (tmp_path / selfcheck.CONTRADICTIONS_PATH).exists()
    run._batch_stage = "batch_final"
    await call(run, **args(review_action="resolved", review_id=note["id"], investigation="Later source confirms version A for new installs."))
    assert review_notes.read(str(tmp_path))[0]["state"] == "resolved"
    assert not (tmp_path / selfcheck.CONTRADICTIONS_PATH).exists()


@pytest.mark.asyncio
async def test_corrupt_notes_and_invalid_identity_never_overwrite(tmp_path):
    path = tmp_path / review_notes.PATH
    path.parent.mkdir(); path.write_text("invalid")
    run = compile_box.CompileRun("bad", str(tmp_path), 1)
    await call(run, **args())
    assert path.read_text() == "invalid" and not (tmp_path / selfcheck.CONTRADICTIONS_PATH).exists()
    path.write_text("[]")
    assert "does not exist" in await call(run, **decision(review_id="unknown"))
    assert path.read_text() == "[]"


@pytest.mark.asyncio
async def test_investigation_survives_durable_sync_without_becoming_ticket(tmp_path):
    run = compile_box.CompileRun("save", str(tmp_path), 1)
    await call(run, **args())
    await compile_box._sync_workspace(run, {}, durable_barrier=True)
    event = run.events.get_nowait()
    paths = {a["path"] for a in event["artifacts"]}
    assert review_notes.PATH in paths and selfcheck.CONTRADICTIONS_PATH not in paths


def test_media_review_is_opt_in_and_advisory(monkeypatch):
    import mediaverify
    monkeypatch.delenv("KBC_MEDIA_VERIFY", raising=False)
    assert not compile_box._media_verify_enabled()
    monkeypatch.setenv("KBC_MEDIA_VERIFY", "on")
    assert compile_box._media_verify_enabled()
    for locale in ["en", "zh"]:
        prompt = mediaverify.build_repair_prompt([], locale)
        assert "mechanically" not in prompt and "change it to the transcribed" not in prompt


def test_served_writes_cannot_bypass_investigation_gate(tmp_path):
    run = compile_box.CompileRun("guard", str(tmp_path), 1)
    for path in [review_notes.PATH, selfcheck.CONTRADICTIONS_PATH]:
        with pytest.raises(ValueError, match="file_ticket"):
            compile_box._validate_compile_write(run, tmp_path / path, "[]")


def test_incremental_media_only_schedules_scope_without_certifying_old_debt(tmp_path, monkeypatch):
    run = compile_box.CompileRun("incremental-media", str(tmp_path), 1)
    pending = {"changed.md": ["old-image.png"], "new.md": ["new-image.png"], "untouched.md": ["historic.png"]}
    monkeypatch.setattr(selfcheck, "pending_media_verification", lambda _: pending)
    selfcheck.write_selfcheck(str(tmp_path), {"state": "passed", "incremental": {"media_review_pages": ["changed.md", "new.md"]}})
    assert compile_box._pending_media_for_run(run) == {k: pending[k] for k in ["changed.md", "new.md"]}
    assert "verified_fingerprints" not in json.dumps(selfcheck.read_selfcheck(str(tmp_path)))
    # Scope is persisted: a fresh worker over the same checkpoint stays scoped.
    resumed = compile_box.CompileRun("resumed", str(tmp_path), 2)
    assert compile_box._pending_media_for_run(resumed) == compile_box._pending_media_for_run(run)
    monkeypatch.setenv("KBC_PK_MODE", "auto")
    (tmp_path / "candidate").mkdir()
    (tmp_path / "candidate/index.md").write_text("# Index")
    assert compile_box._pk_due(resumed) is None
    selfcheck.write_selfcheck(str(tmp_path), {"state": "passed"})
    assert compile_box._pending_media_for_run(resumed) == pending


def test_exact_read_receipts_survive_unrelated_new_pages_but_search_does_not():
    import finalization
    fingerprints = {"a.md": "a", "b.md": "b"}
    unit = {"kind": "semantic", "targets": ["a.md"]}
    finalization.complete(unit, fingerprints, "context", finalization.DependencyReads(["a.md"]), "checked")
    assert finalization.valid(unit, {**fingerprints, "new.md": "new"}, "context")
    assert not finalization.valid(unit, {**fingerprints, "a.md": "changed"}, "context")
    reads = finalization.DependencyReads(["a.md"])
    reads.membership_sensitive = True
    finalization.complete(unit, fingerprints, "context", reads, "searched")
    assert not finalization.valid(unit, {**fingerprints, "new.md": "new"}, "context")
    unit.pop("membership_sensitive")
    assert not finalization.valid(unit, {**fingerprints, "new.md": "new"}, "context")


@pytest.mark.asyncio
async def test_negative_search_keeps_membership_dependency(tmp_path, monkeypatch):
    from types import SimpleNamespace
    import finalization
    root = tmp_path / "candidate"
    root.mkdir(); (root / "a.md").write_text("# A\nSome fact")
    run = compile_box.CompileRun("search", str(tmp_path), 1)
    run._finalization_plan = {"finalization": {}}
    run._finalization_reads = finalization.DependencyReads()
    monkeypatch.setattr(compile_box.pi_config, "for_role", lambda *a, **kw: {})
    monkeypatch.setattr(compile_box, "create_agent_client", lambda **kw: SimpleNamespace(**kw))
    client = compile_box._compile_session_client(run, str(tmp_path), "fixture", "session")
    tools = {t.name: t for t in client.tools}
    await tools["Grep"].handler({"path": str(root), "pattern": "nonexistent"})
    assert run._finalization_reads.membership_sensitive
    assert "a.md" in run._finalization_reads


@pytest.mark.asyncio
async def test_ticket_save_retry_reuses_reserved_identity(tmp_path, monkeypatch):
    run = compile_box.CompileRun("retry", str(tmp_path), 1)
    original = selfcheck.file_ticket_record
    monkeypatch.setattr(selfcheck, "file_ticket_record", lambda *_: ("", "fixture failure"))
    await call(run, **decision())
    note = review_notes.read(str(tmp_path))[0]
    assert note["state"] == "pending" and "ticket_id" not in note
    monkeypatch.setattr(selfcheck, "file_ticket_record", original)
    values = decision(review_id=note["id"]); values["question"] = "Reworded same question"
    await call(run, **values)
    rows = json.loads((tmp_path / selfcheck.CONTRADICTIONS_PATH).read_text())
    assert len(rows) == 1 and rows[0]["id"] == note["proposed_ticket_id"]


@pytest.mark.asyncio
async def test_incremental_scope_survives_internal_repair_and_full_compile_clears_it(tmp_path):
    import incremental
    raw = tmp_path / "raw"; raw.mkdir(); (raw / "a.md").write_text("source")
    candidate = tmp_path / "candidate"; candidate.mkdir()
    (candidate / "index.md").write_text('---\nokf_version: "0.2"\n---\n- [A](a.md)\n')
    page = candidate / "a.md"
    page.write_text('---\ntype: concept\ntitle: A\nsources:\n- resource: a.md\n---\nFact')
    run = compile_box.CompileRun("repair-scope", str(tmp_path), 1)
    selfcheck.write_selfcheck(str(tmp_path), {"state": "passed", "incremental": {"media_review_pages": ["affected.md"]}})
    run._turn_page_hashes = incremental.page_hashes(str(tmp_path))
    page.write_text(page.read_text()+" changed")
    await compile_box._post_turn_selfcheck(run, allow_repair=False)
    assert set(selfcheck.read_selfcheck(str(tmp_path))["incremental"]["media_review_pages"]) >= {"affected.md", "a.md"}
    run._full_compile_pending = True; run._selfcheck_key = None
    await compile_box._post_turn_selfcheck(run, allow_repair=False)
    assert "incremental" not in selfcheck.read_selfcheck(str(tmp_path))


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["model_gap", "source_conflict"])
@pytest.mark.parametrize("inherited", [False, True])
@pytest.mark.parametrize("action", ["investigate", "needs_owner"])
async def test_pending_investigation_redetects_existing_ticket_without_rewriting_it(tmp_path, kind, inherited, action):
    run = compile_box.CompileRun("redetection", str(tmp_path), 1)
    run._command_context = ("op-old", 1)
    values = decision()
    values["ticket_kind"] = kind
    if kind == "source_conflict":
        values["sources"].append({"doc": "raw/other.md", "quote": "Conflicting version"})
    await call(run, **values)
    note = review_notes.read(str(tmp_path))[0]
    path = tmp_path / selfcheck.CONTRADICTIONS_PATH
    tickets = json.loads(path.read_text())
    tickets[0].update(answer="Keep the existing owner choice", agent_report={"note": "retained"})
    path.write_text(json.dumps(tickets))
    before = json.loads(path.read_text())
    pending = {**values, "review_action": action}
    if action == "needs_owner":
        run._batch_active = True
        run._batch_stage = "batch_map"
    if inherited:
        (tmp_path / review_notes.PATH).unlink()
    else:
        pending["review_id"] = note["id"]
        pending["question"] = "Reworded existing issue"
    run._command_context = ("op-new", 2)
    await call(run, **pending)
    after = json.loads(path.read_text())
    assert len(after) == 1 and after[0]["filed_operation_id"] == "op-new"
    assert after[0]["filed_generation"] == 2
    assert {k: v for k, v in after[0].items() if k not in {"filed_operation_id", "filed_generation"}} == {
        k: v for k, v in before[0].items() if k not in {"filed_operation_id", "filed_generation"}}
    assert review_notes.read(str(tmp_path))[0]["ticket_id"] == before[0]["id"]


@pytest.mark.asyncio
async def test_legacy_ticket_explicit_link_and_rewording_reuse_one_investigation(tmp_path):
    run = compile_box.CompileRun("legacy-link", str(tmp_path), 1)
    path = tmp_path / selfcheck.CONTRADICTIONS_PATH
    path.parent.mkdir()
    legacy = {"id": "legacy-owner-42", "question": "Old wording", "ticket_kind": "model_gap",
              "filed_operation_id": "old", "answer": "Keep A", "status": "resolved"}
    path.write_text(json.dumps([legacy]))
    run._command_context = ("new", 2)
    for question in ["Different wording", "Another wording"]:
        values = args(existing_ticket_id=legacy["id"])
        values["question"] = question
        await call(run, **values)
    notes = review_notes.read(str(tmp_path))
    assert len(notes) == 1 and notes[0]["ticket_id"] == legacy["id"]
    tickets = json.loads(path.read_text())
    assert len(tickets) == 1 and tickets[0]["answer"] == "Keep A"
    assert tickets[0]["question"] == "Old wording" and tickets[0]["filed_operation_id"] == "new"
    before = path.read_text()
    assert "does not exist" in await call(run, **args(existing_ticket_id="absent"))
    assert path.read_text() == before
    tickets.append({**legacy, "id": "other-ticket"}); path.write_text(json.dumps(tickets))
    before = path.read_text()
    assert "conflicts" in await call(run, **args(review_id=notes[0]["id"], existing_ticket_id="other-ticket"))
    assert path.read_text() == before


@pytest.mark.asyncio
async def test_failed_note_save_keeps_detection_and_retry_preserves_owner_answer(tmp_path, monkeypatch):
    run = compile_box.CompileRun("save-retry", str(tmp_path), 1)
    run._command_context = ("old", 1)
    await call(run, **decision())
    note = review_notes.read(str(tmp_path))[0]
    path = tmp_path / selfcheck.CONTRADICTIONS_PATH
    tickets = json.loads(path.read_text()); tickets[0]["answer"] = "Owner chose A"
    path.write_text(json.dumps(tickets))
    run._command_context = ("new", 2)
    original = review_notes.save
    def fail(*_): raise OSError("fixture note-save failure")
    monkeypatch.setattr(review_notes, "save", fail)
    assert "fixture note-save failure" in await call(run, **args(review_id=note["id"]))
    assert json.loads(path.read_text())[0]["filed_operation_id"] == "new"
    monkeypatch.setattr(review_notes, "save", original)
    await call(run, **args(review_id=note["id"]))
    assert len(json.loads(path.read_text())) == 1
    assert json.loads(path.read_text())[0]["answer"] == "Owner chose A"
