"""Live box credential recovery without changing its execution contract."""

from copy import deepcopy
from contextlib import asynccontextmanager
import asyncio
import json
import uuid
import pytest
import model_access

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import compile_box
import pi_config


def execution(key="old-key"):
    role = {"source_model_id": "model-binding", "model": {"id": "fixture-model", "name": "Fixture", "provider": "fixture",
                      "api": "openai-completions", "baseUrl": "https://provider.invalid/v1",
                      "reasoning": False, "input": ["text"], "contextWindow": 128000,
                      "maxTokens": 2048, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
            "api_key": key, "thinking_level": "off"}
    return {"version": 1, "roles": {name: deepcopy(role) for name in
            ("compile", "blue", "judge", "transcribe", "compare")}}


async def test_live_session_refreshes_rotated_key_without_restarting_run(tmp_path, monkeypatch):
    monkeypatch.setattr(pi_config, "_roles", {})
    monkeypatch.setattr(pi_config, "_agent_type", None)
    pi_config.configure(execution())
    run = compile_box.CompileRun("live-run", str(tmp_path), 1)
    monkeypatch.setattr(compile_box, "RUNS", {run.run_id: run})
    app = web.Application()
    app.router.add_post("/session/{run_id}", compile_box.handle_session)
    async with TestClient(TestServer(app)) as client:
        response = await client.post("/session/live-run", json={"llm": {
            "engine": "pi_agent", "execution": execution("rotated-key")}})
        assert response.status == 200
        assert (await response.json())["already_live"]
    assert pi_config.for_role("blue")["api_key"] == "rotated-key"
    assert compile_box.RUNS[run.run_id] is run


@asynccontextmanager
async def recovery_proxy(respond, *, protocol="openai-completions", refresh_error=False):
    calls, refreshes = [], []
    current = {"key": "old-key"}

    async def upstream(request):
        calls.append({"headers": dict(request.headers), "body": await request.read()})
        return await respond(request, calls, current)

    upstream_app = web.Application()
    upstream_app.router.add_post("/v1/{path:.*}", upstream)
    async with TestServer(upstream_app) as provider:
        app = web.Application()
        app.on_startup.append(model_access.start)
        app.router.add_post("/model-credentials/{run_id}/{request_id}", model_access.receive)
        async with TestClient(TestServer(app)) as control:
            async def emit(event):
                refreshes.append(event)
                reply = {"error": "unavailable"} if refresh_error else {"api_key": current["key"]}
                async with control.post("/model-credentials/run/" + event["request_id"], json=reply) as response:
                    assert response.status == 200
            model_access.configure("run", emit)
            config = execution()["roles"]["blue"]
            config["model"]["baseUrl"] = str(provider.make_url("/v1"))
            config["model"]["api"] = protocol
            config["auth_header"] = protocol != "anthropic-messages"
            url = model_access.route(config)["model"]["baseUrl"] + "/request"
            yield control.session, url, calls, refreshes


@pytest.mark.parametrize("protocol", ["openai-completions", "openai-responses", "anthropic-messages"])
async def test_rejected_key_rotates_inside_same_model_request(protocol):
    async def respond(request, calls, current):
        if len(calls) == 1:
            current["key"] = "new-key"
            return web.json_response({"error": "unauthorized"}, status=401)
        header = "x-api-key" if protocol == "anthropic-messages" else "Authorization"
        assert request.headers[header] == ("new-key" if header == "x-api-key" else "Bearer new-key")
        return web.json_response({"answer": "recovered"})
    async with recovery_proxy(respond, protocol=protocol) as (session, url, calls, refreshes):
        async with session.post(url, json={"messages": [{"role": "tool", "content": "already executed"}]}) as response:
            assert response.status == 200
            assert (await response.json())["answer"] == "recovered"
        assert len(calls) == len(refreshes) == 2
        assert calls[0]["body"] == calls[1]["body"]
        assert "old-key" not in str(refreshes) and "new-key" not in str(refreshes)


@pytest.mark.parametrize("status,expected_calls", [(503, 2), (429, 2), (402, 1), (401, 2), (400, 1)])
async def test_recovery_is_bounded_and_does_not_retry_unchanged_billing_refusal(status, expected_calls):
    async def respond(request, calls, current):
        return web.json_response({"error": "unavailable"}, status=status)
    async with recovery_proxy(respond) as (session, url, calls, refreshes):
        async with session.post(url, json={}) as response:
            assert response.status == status
        assert len(calls) == expected_calls


async def test_transient_provider_recovers_without_replaying_a_turn():
    async def respond(request, calls, current):
        return web.json_response({"answer": "ok"}, status=503 if len(calls) == 1 else 200)
    async with recovery_proxy(respond) as (session, url, calls, refreshes):
        async with session.post(url, json={}) as response:
            assert response.status == 200
        assert len(calls) == 2


async def test_refresh_failure_never_sends_stale_key_to_provider():
    async def respond(request, calls, current):
        raise AssertionError("must not call upstream")
    async with recovery_proxy(respond, refresh_error=True) as (session, url, calls, _):
        async with session.post(url, json={}) as response:
            assert response.status == 503
        assert calls == []


async def test_credential_refresh_rejects_partial_contract_change_atomically(monkeypatch):
    monkeypatch.setattr(pi_config, "_roles", {})
    monkeypatch.setattr(pi_config, "_agent_type", None)
    pi_config.configure(execution())
    changed = execution("new-key")
    changed["roles"]["compare"]["model"]["baseUrl"] = "https://another.invalid"
    with pytest.raises(ValueError):
        pi_config.refresh_credentials(changed)
    assert all(config["api_key"] == "old-key" for config in pi_config._roles.values())


async def test_test_model_change_is_rejected_before_question_is_submitted(tmp_path, monkeypatch):
    monkeypatch.setattr(pi_config, "_roles", {})
    monkeypatch.setattr(pi_config, "_agent_type", None)
    monkeypatch.setattr(compile_box, "_test_sdk_version", lambda *_: "fixture")
    pi_config.configure(execution())
    run = compile_box.TestRun("test", str(tmp_path), "parent", "snapshot")
    run.consumer_max_turns = 60
    run.consumer_fingerprint = compile_box._test_consumer_fingerprint(None, None, max_turns=60)
    monkeypatch.setattr(compile_box, "TEST_SESSIONS", {"test": run})
    newer = execution()
    newer["roles"]["blue"]["model"]["id"] = "new-test-model"
    app = web.Application()
    app.router.add_post("/test-message/{tid}", compile_box.handle_test_message)
    async with TestClient(TestServer(app)) as client:
        response = await client.post("/test-message/test", json={"message": "next question",
            "llm": {"engine": "pi_agent", "execution": newer}})
        assert response.status == 409
        assert (await response.json())["error"]["code"] == "kb_test_model_changed"
    assert not run._turn_active
    assert pi_config.role_model("compile") == "fixture-model"


def test_test_session_has_its_own_model_without_changing_compiler(tmp_path, monkeypatch):
    monkeypatch.setattr(pi_config, "_roles", {})
    monkeypatch.setattr(pi_config, "_agent_type", None)
    monkeypatch.setenv("KBC_ENGINE", "pi_agent")
    pi_config.configure(execution())
    run = compile_box.TestRun("test", str(tmp_path), "parent", "snapshot")
    selected = execution()
    selected["roles"]["blue"]["model"]["id"] = "new-test-model"
    run.consumer_model = "new-test-model"
    run.consumer_llm = {"engine": "pi_agent", "execution": selected}
    client = compile_box._build_test_client(run, "sdk")
    assert client.config["model"]["id"] == "new-test-model"
    assert pi_config.role_model("compile") == "fixture-model"


async def test_real_pi_worker_keeps_completed_tool_result_across_key_recovery(tmp_path):
    from agent_protocol import EngineTool
    from pi_engine import PiAgentClient
    from test_pi_engine import completion, collect
    tool_calls = []

    async def tool(args):
        tool_calls.append(args)
        return "tool result already committed"

    async def respond(request, calls, current):
        if len(calls) == 1:
            return completion(tool=("Read", {"path": "page.md"}))
        if len(calls) == 2:
            current["key"] = "new-key"
            return web.json_response({"error": {"message": "invalid key"}}, status=401)
        return completion("recovered answer")

    async with recovery_proxy(respond) as (_, url, calls, refreshes):
        config = execution()["roles"]["blue"]
        config["model"]["baseUrl"] = url.removesuffix("/request")
        client = PiAgentClient(cwd=str(tmp_path), system_prompt="Read the page.", session_id="real-recovery",
            model_config=config, tools=[EngineTool("Read", "Read page", {
                "type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}, tool)])
        try:
            await client.connect()
            await client.query("Read once and answer")
            events = await collect(client)
            assert events[-1].data["outcome"] == "completed", events[-1].data.get("error")
            assert len(tool_calls) == 1
            assert len(calls) == 3
            assert calls[1]["body"] == calls[2]["body"]
        finally:
            await client.disconnect()


async def test_real_claude_session_recovers_rotated_key_without_sdk_restart(tmp_path):
    from claude_engine import ClaudeAgentClient
    from test_claude_engine import response as completion
    from test_pi_engine import collect

    async def respond(request, calls, current):
        if len(calls) == 1:
            current["key"] = "new-key"
            return web.json_response({"type": "error", "error": {"type": "authentication_error", "message": "key expired"}}, status=401)
        assert request.headers["x-api-key"] == "new-key"
        return completion(text="recovered without a new process")

    async with recovery_proxy(respond, protocol="anthropic-messages") as (_, url, calls, _):
        config = execution()["roles"]["blue"]
        config["model"].update({"api": "anthropic-messages", "id": "claude-fixture", "baseUrl": url.removesuffix("/request")})
        config["auth_header"] = False
        client = ClaudeAgentClient(cwd=str(tmp_path), system_prompt="Answer briefly.", session_id=str(uuid.uuid4()),
                                   model_config=config, tools=[])
        try:
            await client.connect()
            process = client._client
            await client.query("Hello")
            events = await collect(client)
            assert events[-1].data["outcome"] == "completed", events[-1].data.get("error")
            assert client._client is process
            assert len(calls) == 2
        finally:
            await client.disconnect()


async def test_partial_stream_is_never_replayed():
    async def respond(request, calls, current):
        result = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await result.prepare(request)
        await result.write(b'data: {"partial":"answer"}\n\n')
        request.transport.close()
        return result
    async with recovery_proxy(respond) as (session, url, calls, _):
        import aiohttp
        with pytest.raises(aiohttp.ClientError):
            async with session.post(url, json={}) as response:
                assert response.status == 200
                await response.read()
        assert len(calls) == 1


async def test_error_body_redacts_rotated_key_and_honors_long_cooldown():
    async def respond(request, calls, current):
        if len(calls) == 1:
            current["key"] = "new-key"
            return web.json_response({"error": "old-key"}, status=401)
        return web.json_response({"error": "new-key"}, status=429, headers={"Retry-After": "60"})
    async with recovery_proxy(respond) as (session, url, calls, _):
        async with session.post(url, json={}) as response:
            assert response.status == 429 and response.headers["Retry-After"] == "60"
            text = await response.text()
            assert "new-key" not in text and "old-key" not in text
        assert len(calls) == 2


async def test_parallel_key_failures_share_one_rotation():
    async def respond(request, calls, current):
        if request.headers["Authorization"] == "Bearer old-key":
            current["key"] = "new-key"
            return web.json_response({"error": "expired"}, status=401)
        return web.json_response({"answer": "ok"})
    async with recovery_proxy(respond) as (session, url, _, refreshes):
        async def ask():
            async with session.post(url, json={}) as response:
                assert response.status == 200
                await response.read()
        await asyncio.gather(*(ask() for _ in range(5)))
        assert len(refreshes) == 2


async def test_cancelled_refresh_releases_pending_request(monkeypatch):
    emitted = asyncio.Event()
    async def emit(event):
        emitted.set()
    monkeypatch.setattr(model_access, "_emit", emit)
    monkeypatch.setattr(model_access, "_lock", asyncio.Lock())
    monkeypatch.setattr(model_access, "_pending", {})
    target = {"identity": {"source_model_id": "fixture"}, "api_key": "old", "refreshed": 0.0}
    task = asyncio.create_task(model_access.refresh(target))
    await emitted.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert model_access._pending == {}


def _codex_jwt(account, marker):
    import base64
    def part(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    return ".".join([part({"alg": "none"}), part({"https://api.openai.com/auth": {"chatgpt_account_id": account},
                                                  "marker": marker}), "signature"])


def test_codex_subscription_api_is_a_valid_pi_protocol():
    config = execution()
    config["roles"]["compile"]["model"]["api"] = "openai-codex-responses"
    config["roles"]["compile"]["auth_header"] = False
    pi_config.validate_execution(config)
    config["roles"]["compile"]["model"]["api"] = "openai-mystery"
    with pytest.raises(ValueError, match="Unsupported Pi model protocol"):
        pi_config.validate_execution(config)


async def test_real_pi_worker_runs_codex_subscription_through_live_transport(tmp_path):
    from pi_engine import PiAgentClient
    from test_pi_engine import collect
    from test_pi_responses import response
    old_key, new_key = _codex_jwt("acct-fixture", "old"), _codex_jwt("acct-fixture", "new")
    posts, upgrades, refreshes = [], [], []

    async def codex(request):
        if request.method != "POST":
            upgrades.append(request.method)
            return web.Response(status=426)
        posts.append(dict(request.headers))
        await request.read()
        if len(posts) == 1:
            return web.json_response({"error": {"message": "expired"}}, status=401)
        return response(text="codex answer")

    upstream_app = web.Application()
    upstream_app.router.add_route("*", "/v1/codex/responses", codex)
    # The real Codex backend decodes zstd bodies; the fixture only needs the raw bytes.
    upstream_runner = web.AppRunner(upstream_app, auto_decompress=False)
    await upstream_runner.setup()
    upstream_site = web.TCPSite(upstream_runner, "127.0.0.1", 0)
    await upstream_site.start()
    upstream_url = f"http://127.0.0.1:{upstream_site._server.sockets[0].getsockname()[1]}/v1"
    try:
        app = web.Application()
        app.on_startup.append(model_access.start)
        app.router.add_post("/model-credentials/{run_id}/{request_id}", model_access.receive)
        async with TestClient(TestServer(app)) as control:
            async def emit(event):
                refreshes.append(event)
                async with control.post("/model-credentials/run/" + event["request_id"], json={"api_key": new_key}) as reply:
                    assert reply.status == 200
            model_access.configure("run", emit)
            config = execution(old_key)["roles"]["compile"]
            config["model"].update({"api": "openai-codex-responses", "baseUrl": upstream_url,
                                    "reasoning": True, "input": ["text", "image"]})
            config["auth_header"] = False
            client = PiAgentClient(cwd=str(tmp_path), system_prompt="Answer briefly.", session_id="codex-subscription",
                                   model_config=model_access.route(config), tools=[])
            try:
                await client.connect()
                await client.query("Say hello")
                events = await collect(client)
            finally:
                await client.disconnect()
    finally:
        await upstream_runner.cleanup()
    assert events[-1].data["outcome"] == "completed", events[-1].data.get("error")
    assert upgrades == [], "the loopback transport carries HTTP only; no WebSocket upgrade may be attempted"
    assert len(posts) == len(refreshes) == 2  # admission refresh, then the rejected-bearer refresh
    assert all(headers.get("chatgpt-account-id") == "acct-fixture" for headers in posts)
    assert posts[1]["Authorization"] == "Bearer " + new_key
    assert old_key not in str(refreshes) and new_key not in str(refreshes)
