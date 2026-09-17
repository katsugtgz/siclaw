"""Media verification durability and progress at the actual sync boundary."""

import asyncio
import json
import tempfile
from pathlib import Path

import mediaverify
from test_mediaverify import FakeEngine, _mk


def test_large_transcript_cache_survives_workspace_sync():
    from compile_box import _collect_workspace_artifacts

    with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as recovered:
        cache = {f"charts/{i}.png": {"sha8": f"{i:08x}", "transcript": {"notes": "x" * 5500}}
                 for i in range(220)}
        assert len(json.dumps(cache)) > 1024 * 1024
        mediaverify.save_transcripts(td, cache)
        for artifact in _collect_workspace_artifacts(td):
            path = Path(recovered) / artifact["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(artifact["content"], encoding="utf-8")
        assert mediaverify.load_transcripts(recovered) == cache


def test_completed_transcript_is_saved_before_sibling_finishes():
    async def run():
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            for name in ["a", "b"]:
                _mk(root, f"raw/{name}.png", name)
            _mk(root, "candidate/p.md", "page")
            block = asyncio.Event()
            first = asyncio.Event()

            class Engine(FakeEngine):
                async def run_readonly_agent(self, **kwargs):
                    if kwargs.get("role") == "transcribe":
                        if "b.png" in kwargs["user_message"]:
                            await block.wait()
                        else:
                            first.set()
                    return await super().run_readonly_agent(**kwargs)

            task = asyncio.create_task(mediaverify.run_blind_verify(Engine(), td, {"p.md": ["a.png", "b.png"]}))
            try:
                await first.wait()
                await asyncio.sleep(0)
                assert "a.png" in mediaverify.load_transcripts(td)
            finally:
                block.set()
                await task
    asyncio.run(run())


def test_changed_cached_image_counts_as_new_transcription():
    async def run():
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _mk(root, "raw/chart.png", "old-image")
            _mk(root, "candidate/p.md", "page")
            engine = FakeEngine()
            await mediaverify.run_blind_verify(engine, td, {"p.md": ["chart.png"]})
            _mk(root, "raw/chart.png", "new-image")
            result = await mediaverify.run_blind_verify(engine, td, {"p.md": ["chart.png"]})
            assert result["cache_hits"] == 0
    asyncio.run(run())


def test_group_progress_counts_cache_and_failures_without_source_content():
    from test_mediaverify import _PartialEngine
    from media_progress import PROGRESS_PATH

    async def run():
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _mk(root, "raw/s/i1.png", "image")
            _mk(root, "raw/s/bad.png", "bad-image")
            _mk(root, "candidate/p.md", "page")
            _mk(root, "candidate/q.md", "page")
            _mk(root, "authoring/SELFCHECK.json", json.dumps({"media_verify": {"verified_fingerprints": {"q.md": "older"}}}))
            mediaverify.save_transcripts(td, {"s/i1.png": {"sha8": mediaverify._sha8(root / "raw/s/i1.png"), "transcript": {"facts": []}}})
            snapshots = []

            async def snapshot():
                snapshots.append(json.loads((root / PROGRESS_PATH).read_text()))

            await mediaverify.run_blind_verify(_PartialEngine(), td, {"p.md": ["s/i1.png"], "q.md": ["s/bad.png"]}, run_id="current-run", on_progress=snapshot)
            last = snapshots[-1]
            assert last["run_id"] == "current-run" and last["phase"] == "complete"
            assert (last["images_total"], last["cache_hits"], last["transcribed"], last["transcription_failed"]) == (2, 1, 0, 1)
            assert (last["pages_total"], last["pages_compared"], last["comparison_failed"]) == (2, 1, 1)
            assert (last["missing_receipt_pages"], last["changed_pages"]) == (1, 1)
            assert last["last_progress_at"]
            assert "s/i1.png" not in json.dumps(last)
            assert [s["phase"] for s in snapshots] == ["transcribing", "comparing", "complete"]
    asyncio.run(run())


def test_media_sync_does_not_publish_unsealed_candidate():
    import compile_box
    from media_progress import PROGRESS_PATH

    async def run():
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _mk(root, "candidate/inflight.md", "unsealed")
            _mk(root, PROGRESS_PATH, "{}")
            mediaverify.save_transcripts(td, {"chart.png": {"sha8": "abcd", "transcript": {}}})
            run = compile_box.CompileRun("run", td, 1)
            run._sync_sent = {}
            events = []

            async def emit(event): events.append(event)

            run.emit = emit
            await compile_box._sync_media_progress(run)
            paths = [a["path"] for e in events for a in e.get("artifacts", [])]
            assert PROGRESS_PATH in paths
            assert any(p.startswith(mediaverify.TRANSCRIPTS_DIR + "/") for p in paths)
            assert "candidate/inflight.md" not in paths
            await compile_box._sync_media_progress(run)
            assert len(events) == 1
    asyncio.run(run())
