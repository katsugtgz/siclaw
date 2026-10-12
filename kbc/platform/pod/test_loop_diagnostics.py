import asyncio
import contextlib
import json
import time

import loop_diagnostics


async def test_records_loop_blocking_and_stops_on_cancellation():
    records = []
    def emit(message, **_):
        records.append(json.loads(message))
    task = asyncio.create_task(loop_diagnostics.watch_loop(interval=0.01, threshold=0.02, cooldown=30, emit=emit))
    try:
        await asyncio.sleep(0.02)
        time.sleep(0.06)  # An actual synchronous handler blocks the health loop too.
        await asyncio.sleep(0.02)
        time.sleep(0.06)
        await asyncio.sleep(0.02)
        assert len(records) == 1
        assert records[0]["event"] == "kbc.event_loop_lag"
        assert records[0]["lag_ms"] >= 20
        assert set(records[0]) == {"event", "lag_ms"}
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    assert task.done()
