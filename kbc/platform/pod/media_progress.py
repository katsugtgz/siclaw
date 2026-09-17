"""Bounded, run-owned media progress; counters describe one verification group."""

import asyncio
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

PROGRESS_PATH = "authoring/MEDIA_VERIFY_PROGRESS.json"
SYNC_INTERVAL_SECS = 10


class MediaProgress:
    def __init__(self, workdir, run_id, images, pages, missing_receipts, on_progress=None):
        self.path = Path(workdir) / PROGRESS_PATH
        self.on_progress = on_progress
        self.last_emit = float("-inf")
        self.lock = asyncio.Lock()
        self.value = {
            "version": 1, "run_id": run_id, "group_id": str(uuid.uuid4()),
            "started_at": self.now(), "last_progress_at": None,
            "images_total": images, "pages_total": pages,
            "missing_receipt_pages": missing_receipts,
            "changed_pages": pages - missing_receipts,
            "cache_hits": 0, "transcribed": 0, "transcription_failed": 0,
            "pages_compared": 0, "comparison_failed": 0, "findings": 0,
            "cache_entries": 0,
        }

    @staticmethod
    def now():
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds")

    async def advance(self, counter, *, effective=False, **values):
        async with self.lock:
            self.value[counter] += 1
            if effective:
                self.value["last_progress_at"] = self.now()
            await self._save(False, values)

    async def update(self, phase, **values):
        async with self.lock:
            self.value["phase"] = phase
            await self._save(True, values)

    async def gather(self, *coroutines):
        """Flush completed work while the remaining workers are still waiting."""
        tasks = [asyncio.create_task(coroutine) for coroutine in coroutines]
        group = asyncio.gather(*tasks)
        try:
            while True:
                delay = (max(0, SYNC_INTERVAL_SECS - (time.monotonic() - self.last_emit))
                         if self.on_progress else None)
                done, _ = await asyncio.wait({group}, timeout=delay)
                if done:
                    return await group
                async with self.lock:
                    await self._emit(False)
        finally:
            # A cancelled/failed group must not leave workers writing progress
            # after its caller has moved on to recovery or another group.
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(group, *tasks, return_exceptions=True)

    async def _save(self, force, values):
        self.value.update(values)
        self.value["updated_at"] = self.now()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.value, ensure_ascii=False) + "\n", encoding="utf-8")
        temporary.replace(self.path)
        await self._emit(force)

    async def _emit(self, force):
        now = time.monotonic()
        if self.on_progress and (force or now - self.last_emit >= SYNC_INTERVAL_SECS):
            await self.on_progress()
            self.last_emit = time.monotonic()
