"""Compiler assistance must reduce bookkeeping without hiding knowledge or writes."""

import json

import pytest

import candidate_context
import candidate_feedback
import compile_box
from pi_file_tools import FileTools


def page(root, name, source="raw/a.md", body="Evidence."):
    target = root / "candidate" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(f"---\ntype: Topic\ntitle: {name}\ndescription: Useful context\n"
                      f"sources:\n  - resource: {source}\n---\n{body}\n")
    return target


def workspace(root):
    (root / "raw").mkdir()
    (root / "raw/a.md").write_text("source")
    (root / "candidate").mkdir()
    (root / "candidate/index.md").write_text(
        '---\nokf_version: "0.2"\n---\n# Operations\nNetwork and storage interact.\n'
        '## Network\n## Storage\n')


def files(root, feedback=True):
    return FileTools(str(root), ["Read", "Write", "Edit"],
                     compile_box._make_compile_path_guard(root),
                     feedback=(lambda path: candidate_feedback.check_page(root, path)) if feedback else None)


async def test_persisted_write_reports_yaml_then_edit_clears_local_issue(tmp_path):
    workspace(tmp_path)
    tools = files(tmp_path)
    bad = "---\ntype: Topic\ntitle: [unclosed\n---\nEvidence.\n"
    result = await tools.write({"file_path": "candidate/p.md", "content": bad})
    report = json.loads(result["content"][1]["text"])
    assert report["persisted"] and report["status"] == "needs_attention"
    assert report["metadata_error"] and not result.get("isError")
    assert (tmp_path / "candidate/p.md").read_text() == bad
    result = await tools.edit({"file_path": "candidate/p.md", "old_string": bad,
                              "new_string": "---\ntype: Topic\ntitle: Example\n"
                              "sources:\n  - resource: raw/a.md\n---\n"
                              "[Next page](not-created-yet.md)\n"})
    report = json.loads(result["content"][1]["text"])
    assert report["status"] == "no_local_issues"
    assert "cross-page" in report["note"]  # Future links are not false failures.


async def test_feedback_checks_registration_without_fabricating_citations(tmp_path):
    workspace(tmp_path)
    target = page(tmp_path, "p.md", "raw/missing.md", "Claim (source: a.md)")
    before = target.read_bytes()
    report = candidate_feedback.check_page(tmp_path, target)
    assert {i["kind"] for i in report["issues"]} >= {"source_missing", "body_source_uncited"}
    assert target.read_bytes() == before
    with pytest.raises(PermissionError):
        await files(tmp_path).write({"file_path": "raw/a.md", "content": "rewrite"})
    assert (tmp_path / "raw/a.md").read_text() == "source"


async def test_feedback_failure_is_not_a_failed_write_or_replay(tmp_path):
    workspace(tmp_path)
    tools = files(tmp_path)
    def fail(_):
        raise ValueError("private diagnostic text")
    tools.feedback = fail
    result = await tools.write({"file_path": "candidate/p.md", "content": "saved"})
    assert (tmp_path / "candidate/p.md").read_text() == "saved"
    report = json.loads(result["content"][1]["text"])
    assert report["status"] == "check_unavailable" and report["persisted"]
    assert "private diagnostic text" not in str(result)
    assert not result.get("isError")


def test_reserved_pages_and_external_sources_have_no_false_metadata_error(tmp_path):
    workspace(tmp_path)
    target = tmp_path / "candidate/nested/index.md"
    target.parent.mkdir()
    target.write_text("# Nested\n")
    assert candidate_feedback.check_page(tmp_path, target)["status"] == "no_local_issues"
    target = page(tmp_path, "external.md", "https://example.org/source")
    assert candidate_feedback.check_page(tmp_path, target)["status"] == "no_local_issues"


def test_source_lookup_pages_every_match_beyond_old_eight_page_cap(tmp_path):
    workspace(tmp_path)
    for i in range(65):
        page(tmp_path, f"different-topics/p{i:03}.md", "raw/sub/../a.md")
    first = candidate_context.lookup(tmp_path, sources=["a.md"], limit=50)
    assert first["total"] == 65 and first["next_offset"] == 50
    second = candidate_context.lookup(tmp_path, sources=["raw/a.md"], limit=50,
                                      offset=50, revision=first["revision"])
    assert second["next_offset"] is None
    paths = [p["path"] for p in first["pages"] + second["pages"]]
    assert len(set(paths)) == 65
    assert all(p["description"] == "Useful context" for p in first["pages"])


def test_lookup_searches_other_topics_and_requires_current_pagination(tmp_path):
    workspace(tmp_path)
    page(tmp_path, "network.md", body="Unusual dependency on storage quorum")
    page(tmp_path, "storage.md", body="Repair depends on network configuration")
    first = candidate_context.lookup(tmp_path, limit=1)
    found = candidate_context.lookup(tmp_path, query="storage quorum")
    assert [p["path"] for p in found["pages"]] == ["candidate/network.md"]
    assert "storage quorum" in found["pages"][0]["excerpt"]
    page(tmp_path, "new.md")
    assert candidate_context.lookup(tmp_path, offset=1, revision=first["revision"])["restart_required"]
    assert candidate_context.lookup(tmp_path, offset=1)["restart_required"]
    assert len(candidate_context.lookup(tmp_path)["pages"]) == 4


def test_handoff_keeps_global_structure_and_explicit_continuation(tmp_path):
    workspace(tmp_path)
    for i in range(14):
        page(tmp_path, f"p{i:02}.md")
    brief = json.loads(candidate_context.handoff(tmp_path, ["a.md"]))
    assert "Network" in brief["index_headings"] and "Storage" in brief["index_headings"]
    assert "interact" in brief["index_preview"]
    assert brief["same_source_pages"]["total"] == 14
    assert brief["same_source_pages"]["next_offset"] == 12
    assert "Read index.md" in brief["overview_note"]
    for locale in ("en", "zh"):
        text = compile_box._compose_batch_directive(
            {"id": "h001", "sources": ["a.md"]}, 1, 2, "owner note",
            locale=locale, relay=json.dumps(brief), focused_context=True)
        assert "candidate_lookup" in text and "restart_required" in text
        assert "authoring/BRIEF.json" in text and "authoring/INTENT.md" in text
        assert "owner note" in text and "COMPILATION_STATE.json" not in text
        legacy = compile_box._compose_batch_directive(
            {"id": "h001", "sources": ["a.md"]}, 1, 2, "", locale=locale)
        assert "COMPILATION_STATE.json" in legacy


def test_lookup_refuses_symlink_and_does_not_read_external_content(tmp_path):
    workspace(tmp_path)
    external = tmp_path / "outside.md"
    external.write_text("outside secret")
    (tmp_path / "candidate/link.md").symlink_to(external)
    with pytest.raises(ValueError, match="symbolic"):
        candidate_context.lookup(tmp_path)


def test_lookup_reports_invalid_metadata_and_handles_multiline_queries(tmp_path):
    workspace(tmp_path)
    target = page(tmp_path, "broken.md")
    target.write_text("---\ntype: Topic\nsources: invalid\n---\nfirst line\nsecond line\n")
    result = candidate_context.lookup(tmp_path, query="first line\nsecond line")
    assert result["total"] == 1 and result["metadata_issue_count"] == 1
    assert result["pages"][0]["metadata_error"]
    (tmp_path / "candidate/encoding.md").write_bytes(b"\xff")
    assert candidate_context.lookup(tmp_path)["metadata_issue_count"] == 2


def test_lookup_output_budget_still_allows_every_result_to_be_retrieved(tmp_path):
    workspace(tmp_path)
    for i in range(45):
        target = page(tmp_path, f"p{i:02}.md")
        target.write_text(target.read_text().replace("Useful context", "d" * 600))
    seen = set()
    result = candidate_context.lookup(tmp_path, limit=50)
    assert result["truncated"]  # Character budget applies before the row limit.
    while True:
        assert len(json.dumps(result, ensure_ascii=False)) < 27000
        seen.update(row["path"] for row in result["pages"])
        if result["next_offset"] is None:
            break
        result = candidate_context.lookup(tmp_path, limit=50, offset=result["next_offset"],
                                          revision=result["revision"])
    assert len(seen) == 46


async def test_compiler_registry_exposes_lookup_and_write_feedback(tmp_path, monkeypatch):
    workspace(tmp_path)
    monkeypatch.setattr(compile_box.pi_config, "for_role", lambda *a, **kw: {})
    monkeypatch.setattr(compile_box, "create_agent_client", lambda **kw: kw)
    run = compile_box.CompileRun("fixture", str(tmp_path), 1)
    options = compile_box._compile_session_client(run, str(tmp_path), "role", "session")
    tools = {t.name: t for t in options["tools"]}
    assert "mcp__compile__candidate_lookup" in tools
    written = await tools["Write"].handler({"file_path": "candidate/p.md", "content": "invalid"})
    assert json.loads(written["content"][1]["text"])["status"] == "needs_attention"
    found = json.loads(await tools["mcp__compile__candidate_lookup"].handler({}))
    assert found["total"] == 2
    run.allowed_tools = ["Read"]
    restricted = compile_box._compile_session_client(run, str(tmp_path), "role", "other")
    assert [t.name for t in restricted["tools"]] == ["Read"]


def test_optional_navigation_falls_back_without_hiding_failure(tmp_path, monkeypatch, capsys):
    workspace(tmp_path)
    run = compile_box.CompileRun("fixture", str(tmp_path), 1)
    batch = {"sources": ["a.md"]}
    assert compile_box._batch_navigation_context(run, batch)[0]
    run.allowed_tools = ["Read"]
    assert compile_box._batch_navigation_context(run, batch) == (False, "")
    run.allowed_tools = None
    def fail(*args):
        raise RuntimeError("private page contents")
    monkeypatch.setattr(candidate_context, "handoff", fail)
    assert compile_box._batch_navigation_context(run, batch) == (False, "")
    output = capsys.readouterr().out
    assert "batch.context_unavailable" in output and "private page contents" not in output
