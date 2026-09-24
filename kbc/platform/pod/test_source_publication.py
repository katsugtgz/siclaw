"""Publication-status signals for documentation-site sources.

Run: python -m pytest -q test_source_publication.py
"""

import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

import selfcheck
import source_publication as sp


def _mk(base: Path, rel: str, text: str = "x"):
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def _site(base: Path):
    """A Mintlify archive shaped like the production docs sites."""
    _mk(base, "raw/docs.json", json.dumps({"navigation": {"tabs": [
        {"tab": "GPU Cloud", "groups": [{"group": "Start", "pages": [
            "gpu/overview", {"group": "Nested", "pages": ["/gpu/nested/page"]}]}]},
        {"tab": "Siverse", "groups": [{"group": "Start", "pages": ["siverse/overview"]}]},
        {"tab": "Beta", "hidden": True, "groups": [{"group": "B", "pages": ["beta/secret"]}]},
    ]}}))
    _mk(base, "raw/.mintignore",
        "# Mintlify automatically ignores these files\n\n# Draft content\ndrafts/\n*.draft.mdx\n!keep.draft.mdx\n\n"
        "# Temporarily hidden: Siverse (not part of current GTM launch)\nsiverse/\n")
    _mk(base, "raw/gpu/overview.mdx", "---\ntitle: GPU\n---\nbody")
    _mk(base, "raw/gpu/nested/page.mdx", "---\ntitle: N\n---\nbody")
    _mk(base, "raw/gpu/media/shot.png")
    _mk(base, "raw/siverse/overview.mdx", "---\ntitle: Siverse\nsidebarTitle: Overview\nhidden: true\n---\nbody")
    _mk(base, "raw/beta/secret.mdx", "---\ntitle: B\n---\nbody")
    _mk(base, "raw/gpu/old.draft.mdx", "---\ntitle: D\n---\nbody")
    _mk(base, "raw/gpu/keep.draft.mdx", "---\ntitle: K\n---\nbody")
    _mk(base, "raw/snippets/note.mdx", "shared snippet")
    _mk(base, "raw/README.md", "# repo")
    _mk(base, "raw/index.mdx", "---\ntitle: Home\n---\nwelcome")


def test_publication_signals_from_site_files():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _site(base)
        sources = selfcheck.source_inventory(td)
        assert ".mintignore" not in sources  # the ignore file stays out of the inventory
        signals = sp.publication_signals(td, sources)
        kinds = {path: [s["signal"] for s in items] for path, items in signals.items()}
        assert "gpu/overview.mdx" not in kinds and "gpu/nested/page.mdx" not in kinds, kinds
        assert "snippets/note.mdx" not in kinds and "index.mdx" not in kinds, kinds
        assert "gpu/media/shot.png" not in kinds, kinds
        assert kinds["siverse/overview.mdx"] == [sp.HIDDEN, sp.IGNORED], kinds
        detail = signals["siverse/overview.mdx"][1]["detail"]
        assert "Temporarily hidden: Siverse (not part of current GTM launch)" in detail, detail
        assert kinds["beta/secret.mdx"] == [sp.NOT_IN_NAVIGATION], kinds  # hidden nav tab
        assert kinds["gpu/old.draft.mdx"] == [sp.IGNORED, sp.NOT_IN_NAVIGATION], kinds
        assert kinds["gpu/keep.draft.mdx"] == [sp.NOT_IN_NAVIGATION], kinds  # negated ignore
        assert kinds["README.md"] == [sp.NOT_IN_NAVIGATION], kinds


def test_no_site_config_only_frontmatter_counts():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/a.md", "---\nhidden: true\n---\nx")
        _mk(base, "raw/b.md", "no frontmatter\nhidden: true\n")
        _mk(base, "raw/.mintignore", "a.md\n")  # no site root → not consulted
        signals = sp.publication_signals(td, selfcheck.source_inventory(td))
        assert signals == {"a.md": [{"signal": sp.HIDDEN, "detail": "hidden: true"}]}, signals


def test_notice_is_bounded_and_advisory():
    signals = {f"s/p{i:02d}.mdx": [{"signal": sp.HIDDEN, "detail": "hidden: true"}] for i in range(30)}
    notice = sp.publication_notice(signals, en=True, limit=5)
    assert notice.count("\n- ") == 6 and "25 more" in notice, notice
    assert "do not exclude them on your own" in notice
    assert sp.publication_notice(signals, paths=["other.mdx"]) == ""
    zh = sp.publication_notice(signals, paths=["s/p01.mdx"], en=False)
    assert "不要自行排除" in zh and "s/p01.mdx" in zh
    assert sp.publication_summary(signals) == ["   - s/ (30)"]


def test_compile_directives_carry_publication_status():
    import compile_box

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _site(base)
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.2\"\n---\n# Index\n")
        run = SimpleNamespace(workdir=td)
        batch = {"sources": ["siverse/overview.mdx", "gpu/overview.mdx"]}
        brief = compile_box._batch_relay_brief(run, {"batches": [batch]}, batch, 1, 1, locale="en")
        assert "siverse/overview.mdx: frontmatter hidden; site ignore file" in brief, brief
        assert "gpu/overview.mdx" not in brief.split("Source publication status", 1)[1], brief
        clean = {"sources": ["gpu/overview.mdx"]}
        assert "publication status" not in compile_box._batch_relay_brief(
            run, {"batches": [clean]}, clean, 1, 1, locale="en")

        final_en = compile_box._compose_final_directive(td, 1, "", locale="en")
        assert "Unpublished sources (5 page source(s)" in final_en, final_en
        assert "   - gpu/ (2)" in final_en and "   - (root) (1)" in final_en, final_en
        final_zh = compile_box._compose_final_directive(td, 1, "", locale="zh")
        assert "未发布的源(5 个页面源" in final_zh, final_zh


async def test_single_turn_full_compile_carries_publication_status():
    import compile_box

    class _Client:
        def __init__(self):
            self.queries = []

        async def query(self, text, session_id="default"):
            self.queries.append(text)

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _site(base)
        run = compile_box.CompileRun("pub-flat", td, 1)
        run.locale = "en"
        run.client = _Client()
        await compile_box._dispatch_authoring_turn(run, "compile the library", "compile.generate")
        await compile_box._dispatch_authoring_turn(run, "a question about wording")
        full, chat = run.client.queries
        assert full.startswith("compile the library") and "Source publication status" in full, full
        assert "siverse/overview.mdx" in full, full
        assert chat == "a question about wording", chat
