"""Content-free event-loop delay evidence for local health probe timeouts."""

import asyncio
import contextlib
import json


async def watch_loop(*, interval=1.0, threshold=1.0, cooldown=30.0, emit=print):
    loop = asyncio.get_running_loop()
    last_report = float("-inf")
    while True:
        expected = loop.time() + interval
        await asyncio.sleep(interval)
        now = loop.time()
        lag = max(0.0, now - expected)
        if lag >= threshold and now - last_report >= cooldown:
            last_report = now
            emit(json.dumps({"event": "kbc.event_loop_lag", "lag_ms": round(lag * 1000)}), flush=True)


async def lifecycle(_app):
    task = asyncio.create_task(watch_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
