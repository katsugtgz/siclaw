"""Loopback model transport with live credentials and bounded request recovery.

SDK processes keep their conversation and tool state. Only an HTTP request
rejected before any successful response is retried; partial streams are never
replayed. Upstream URLs come exclusively from the frozen execution contract.

A request never waits for a credential refresh unless the provider rejected
its credential. Static API keys refresh only on rejection; rotating
subscription bearers also refresh ahead in the background. A failed refresh
keeps the current credential and is recorded.
"""

import asyncio
from copy import deepcopy
import json
import time
import uuid

import aiohttp
from aiohttp import web
import destream

_port = None
_run_id = None
_emit = None
_pending = {}
_routes = {}
_HOP = {"host", "content-length", "connection", "transfer-encoding", "keep-alive",
        "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"}
_TRANSIENT = {408, 429, 500, 502, 503, 504, 529}
_CREDENTIAL_REJECTED = {401, 402, 403}
# Protocols whose credential is a short-lived bearer rotated by the control plane.
_ROTATING_APIS = {"openai-codex-responses"}
_REFRESH_AHEAD_SECS = 15
_REFRESH_TIMEOUT_SECS = 20


def configure(run_id, emit):
    global _run_id, _emit
    if _run_id is not None and _run_id != run_id:
        raise ValueError("Model transport already belongs to another run")
    _run_id, _emit = run_id, emit


def route(config):
    if _port is None or _emit is None:
        return config  # Older runtimes do not negotiate live credential refresh.
    if not config.get("source_model_id"):
        return config  # Legacy consumer payload, before credential refresh support.
    identity = {key: config["model"][key] for key in ("id", "baseUrl", "api")}
    identity["source_model_id"] = config["source_model_id"]
    identity["auth_header"] = config.get("auth_header", True)
    token = next((token for token, target in _routes.items() if target["identity"] == identity), None)
    if token is None:
        token = uuid.uuid4().hex
        _routes[token] = {"identity": identity, "api_key": config["api_key"], "initial_key": config["api_key"],
                          "auth_header": config.get("auth_header", True), "attempted": time.monotonic(),
                          "refresh": None, "refresh_failures": 0}
    result = deepcopy(config)
    result["model"]["baseUrl"] = f"http://127.0.0.1:{_port}/{token}"
    return result


def _record_refresh_failure(target, reason):
    target["refresh_failures"] += 1
    # Metadata only: never the credential or the control plane's reply.
    print(json.dumps({"event": "kbc.model_credential.refresh_failed", "run_id": _run_id,
                      "source_model_id": target["identity"]["source_model_id"], "reason": reason,
                      "failures": target["refresh_failures"]}), flush=True)


async def _request_refresh(target):
    """Ask the control plane for the model's current credential once."""
    request_id = uuid.uuid4().hex
    future = asyncio.get_running_loop().create_future()
    _pending[request_id] = (target, future)
    try:
        await _emit({"type": "refresh_credentials", "request_id": request_id,
                     "model": target["identity"]})
        await asyncio.wait_for(future, _REFRESH_TIMEOUT_SECS)
        return True
    except TimeoutError:
        _record_refresh_failure(target, "timeout")
    except ValueError:
        _record_refresh_failure(target, "rejected")
    except Exception:  # the event channel itself failed; keep serving requests
        _record_refresh_failure(target, "unavailable")
    finally:
        _pending.pop(request_id, None)
    return False


def _start_refresh(target):
    """Single-flight per model route: concurrent callers share one request."""
    task = target["refresh"]
    if task is None or task.done():
        target["attempted"] = time.monotonic()
        task = asyncio.ensure_future(_request_refresh(target))
        target["refresh"] = task
    return task


def refresh_ahead(target):
    """Keep a rotating bearer fresh without delaying the request in flight."""
    if _emit is None or target["identity"]["api"] not in _ROTATING_APIS:
        return
    if time.monotonic() - target["attempted"] >= _REFRESH_AHEAD_SECS:
        _start_refresh(target)


async def refresh_rejected(target, failed_key):
    """After the provider rejected failed_key, wait for one bounded refresh.

    Returns whether a different credential is now installed. A failed refresh
    leaves the current credential in place for the caller to report.
    """
    if _emit is None:
        return False
    if target["api_key"] == failed_key:
        last = target["refresh"]
        if last is not None and last.done() and not last.cancelled() and last.result() is False and \
                time.monotonic() - target["attempted"] < _REFRESH_AHEAD_SECS:
            return False  # the control plane just failed; do not stall every rejected request
        # Shield: one caller's cancellation must not cancel a refresh that
        # other requests on the same route are waiting for.
        await asyncio.shield(_start_refresh(target))
    return target["api_key"] != failed_key


async def receive(request):
    if request.match_info["run_id"] != _run_id:
        raise web.HTTPNotFound()
    pending = _pending.get(request.match_info["request_id"])
    if pending is None or pending[1].done():
        return web.json_response({"ok": True, "expired": True})
    target, future = pending
    body = await request.json()
    if body.get("error"):
        future.set_exception(ValueError("Model credential refresh failed"))
    else:
        token = body.get("api_key")
        if not isinstance(token, str) or not token.strip():
            future.set_exception(ValueError("Model credential refresh returned no credential"))
        else:
            target["api_key"] = token
            future.set_result(None)
    return web.json_response({"ok": True})


async def handle(request):
    target = _routes.get(request.match_info["token"])
    if target is None:
        raise web.HTTPNotFound()
    upstream, api = target["identity"]["baseUrl"], target["identity"]["api"]
    auth_header = target["auth_header"]
    tail = request.match_info["tail"]
    # Never resolve a caller-supplied URL or follow a redirect with credentials.
    url = upstream.rstrip("/") + "/" + tail
    if request.query_string:
        url += "?" + request.query_string
    body = await request.read()
    refresh_ahead(target)
    timeout = aiohttp.ClientTimeout(total=destream._upstream_timeout(), sock_connect=15)
    async with aiohttp.ClientSession(timeout=timeout, auto_decompress=False) as session:
        for attempt in range(2):
            token = target["api_key"]
            headers = {key: value for key, value in request.headers.items()
                       if key.lower() not in _HOP | {"authorization", "x-api-key"}}
            if api == "anthropic-messages" and not auth_header:
                headers["x-api-key"] = token
            else:
                headers["Authorization"] = "Bearer " + token
            try:
                response = await session.request(request.method, url, data=body, headers=headers, allow_redirects=False)
            except (aiohttp.ClientError, TimeoutError):
                # An ambiguous transport failure may already have reached the
                # provider. Surface it instead of duplicating an accepted call.
                return web.json_response({"error": {"message": "Model connection failed"}}, status=502)
            async with response:
                if attempt == 0 and response.status in _TRANSIENT | _CREDENTIAL_REJECTED:
                    # Only a rejected credential waits for a refresh. If that
                    # refresh fails, the provider's own answer is returned.
                    changed = response.status in _CREDENTIAL_REJECTED and await refresh_rejected(target, token)
                    retry_delay = 0.5
                    retry_after = response.headers.get("Retry-After")
                    if retry_after:
                        try:
                            retry_delay = max(retry_delay, float(retry_after))
                        except ValueError:
                            retry_delay = float("inf")  # Return HTTP-date cooldowns to the caller.
                    if (changed or response.status in _TRANSIENT | {401, 403}) and retry_delay <= 2:
                        response.release()
                        await asyncio.sleep(retry_delay)
                        continue
                if response.status >= 400:
                    # A provider can echo its request key. SDK children only
                    # know their original key, so redact rotated keys here.
                    data = bytearray()
                    async for chunk in response.content.iter_chunked(16384):
                        data.extend(chunk)
                        if len(data) > 65536:
                            break
                    if len(data) > 65536 or response.headers.get("Content-Encoding"):
                        return web.json_response({"error": {"message": "Model provider rejected the request"}}, status=response.status)
                    text = data.decode("utf-8", errors="replace")
                    for secret in {token, target["api_key"], target["initial_key"]}:
                        if secret:
                            text = text.replace(secret, "[REDACTED]")
                    return web.Response(status=response.status, body=text.encode("utf-8"), headers={
                        "Content-Type": response.headers.get("Content-Type", "application/json"),
                        **({"Retry-After": response.headers["Retry-After"]} if "Retry-After" in response.headers else {})})
                # Once response headers/body are exposed to the SDK there is
                # no retry path, including a disconnect during an SSE stream.
                result = web.StreamResponse(status=response.status, headers={
                    key: value for key, value in response.headers.items() if key.lower() not in _HOP})
                await result.prepare(request)
                try:
                    async for chunk in response.content.iter_any():
                        await result.write(chunk)
                    await result.write_eof()
                except (aiohttp.ClientError, ConnectionError, TimeoutError):
                    if request.transport:
                        request.transport.close()
                return result


async def start(app):
    global _port
    proxy = web.Application(client_max_size=64 * 1024 * 1024)
    proxy.router.add_route("*", "/{token}/{tail:.*}", handle)
    # Forward request bodies byte-for-byte. The Codex subscription client sends
    # zstd-compressed JSON with Content-Encoding intact; decoding here would
    # forward plain bytes under that header (or reject them without zstd).
    runner = web.AppRunner(proxy, handler_cancellation=True, auto_decompress=False)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    _port = site._server.sockets[0].getsockname()[1]

    async def stop(_app):
        global _port, _emit, _run_id
        for _, future in _pending.values():
            if not future.done():
                future.cancel()
        for target in _routes.values():
            if target["refresh"] is not None and not target["refresh"].done():
                target["refresh"].cancel()
        await runner.cleanup()
        _pending.clear()
        _routes.clear()
        _port, _emit, _run_id = None, None, None

    app.on_cleanup.append(stop)
