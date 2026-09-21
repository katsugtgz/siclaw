"""API-key Responses wire contract through the real Pi worker and host tools."""

import json

from aiohttp import web

from test_pi_engine import client, collect, provider, allow
from pi_file_tools import FileTools


def response(*, tool=None, text="done"):
    reasoning = {"id": "rs_fixture", "type": "reasoning", "summary": [],
                 "encrypted_content": "opaque-reasoning-fixture"}
    item = ({"type": "function_call", "id": "fc_fixture", "call_id": "call_fixture",
             "name": tool[0], "arguments": json.dumps(tool[1], ensure_ascii=False), "status": "completed"}
            if tool else {"type": "message", "id": "msg_fixture", "role": "assistant",
                          "status": "completed", "phase": "final_answer",
                          "content": [{"type": "output_text", "text": text, "annotations": []}]})
    output = [reasoning, item]
    events = [{"type": "response.created", "response": {"id": "resp_fixture"}}]
    for index, value in enumerate(output):
        events.append({"type": "response.output_item.done", "output_index": index, "item": value})
    events.append({"type": "response.completed", "response": {
        "id": "resp_fixture", "status": "completed", "output": output,
        "usage": {"input_tokens": 42, "output_tokens": 8, "total_tokens": 50,
                  "input_tokens_details": {"cached_tokens": 12}},
    }})
    return web.Response(text="".join(f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n" for event in events),
                        content_type="text/event-stream")


async def test_responses_replays_reasoning_and_host_tool_results(tmp_path):
    content = "尾部事实：恢复阈值 291。🚀\n"
    async with provider(lambda _, n: response(tool=("Write", {"file_path": "page.md", "content": content}))
                        if n == 1 else response(text="Written"), api="openai-responses") as (config, requests):
        config["model"]["reasoning"] = True
        config["model"]["compat"] = {"sessionAffinityFormat": "openai-nosession"}
        config["thinking_level"] = "low"
        async with client(tmp_path, config, FileTools(str(tmp_path), ["Write"], allow).tools()) as instance:
            await instance.query("Write a knowledge page")
            events = await collect(instance)
        assert (tmp_path / "page.md").read_text() == content
        assert len(requests) == 2
        assert all(request["store"] is False and request["stream"] for request in requests)
        first = requests[0]
        assert first["tools"][0]["type"] == "function"
        assert first["reasoning"]["effort"] == "low"
        replay = requests[1]["input"]
        assert next(item for item in replay if item.get("type") == "reasoning")["encrypted_content"] == "opaque-reasoning-fixture"
        call = next(item for item in replay if item.get("type") == "function_call")
        result = next(item for item in replay if item.get("type") == "function_call_output")
        assert result["call_id"] == call["call_id"]
        assert "page.md" in result["output"]
        assert events[-1].data["outcome"] == "completed"
        assert events[-1].data["model_calls"] == 2


async def test_responses_read_failure_returns_to_model(tmp_path):
    async with provider(lambda _, n: response(tool=("Read", {"file_path": "missing.md"}))
                        if n == 1 else response(text="Source is missing"), api="openai-responses") as (config, requests):
        async with client(tmp_path, config, FileTools(str(tmp_path), ["Read"], allow).tools()) as instance:
            await instance.query("Read source")
            events = await collect(instance)
        result = next(item for item in requests[1]["input"] if item.get("type") == "function_call_output")
        assert "missing.md" in result["output"]
        assert events[-1].data["outcome"] == "completed"


async def test_responses_read_with_every_advertised_parameter_can_write_result(tmp_path):
    source = "Synthetic retention rule: keep records for 19 days."
    (tmp_path / "source.md").write_text(source)

    def respond(body, number):
        if number == 1:
            schema = next(tool["parameters"] for tool in body["tools"] if tool["name"] == "Read")
            # Some providers populate every optional property in tool calls.
            values = {"file_path": "source.md", "unit": "lines", "offset": 1, "limit": 200,
                      "offset_bytes": 0, "limit_bytes": 4096, "pages": ""}
            return response(tool=("Read", {key: values[key] for key in schema["properties"]}))
        if number == 2:
            output = next(item["output"] for item in body["input"] if item.get("type") == "function_call_output")
            if source not in output:
                return response(text="Source could not be read")
            return response(tool=("Write", {"file_path": "page.md", "content": source}))
        return response(text="Written")

    async with provider(respond, api="openai-responses") as (config, requests):
        config["model"]["compat"] = {"sessionAffinityFormat": "openai-nosession"}
        async with client(tmp_path, config, FileTools(str(tmp_path), ["Read", "Write"], allow).tools()) as instance:
            await instance.query("Read the source and write its exact rule to page.md")
            events = await collect(instance)
        assert (tmp_path / "page.md").is_file(), "Read must remain usable when all schema properties are populated"
        assert (tmp_path / "page.md").read_text() == source
        assert events[-1].data["outcome"] == "completed"
        assert events[-1].data["model_calls"] == 3


async def test_read_context_diagnostics_match_actual_responses_payload(tmp_path):
    from pi_engine import observe_sessions
    evidence = "PRIVATE-CORPUS-MARKER\n" * 300
    (tmp_path / "index.md").write_text(evidence)
    observed = []

    async def observe(event):
        observed.append(event)

    def respond(body, number):
        if number == 1:
            return response(tool=("Read", {"file_path": "index.md", "limit": 500}))
        results = [x for x in body["input"] if x.get("type") == "function_call_output"]
        assert len(results) == 1 and "PRIVATE-CORPUS-MARKER" in results[0]["output"]
        return response(text="Hello")

    async with provider(respond, api="openai-responses") as (config, requests):
        with observe_sessions(observe):
            async with client(tmp_path, config, FileTools(str(tmp_path), ["Read"], allow).tools()) as instance:
                await instance.query("Hello")
                events = await collect(instance)
    wire = [x["data"] for x in observed if x["kind"] == "model_payload"]
    assert len(wire) == 2, "Every serialized request needs metadata-only tool-result evidence"
    assert wire[1]["summary"]["toolResults"] == 1
    assert wire[1]["summary"]["matchedToolResults"] == 1
    assert wire[1]["summary"]["toolResultChars"] >= len(evidence)
    context = [x["data"] for x in observed if x["kind"] == "model_request"]
    assert context[1]["context"]["toolResults"] == 1
    assert events[-1].data["outcome"] == "completed"
    result = next(x["data"] for x in observed if x["kind"] == "tool_result")
    assert result["text_chars"] >= len(evidence) and result["duration_ms"] >= 0
    assert next(x["data"] for x in observed if x["kind"] == "worker_ready")["duration_ms"] >= 0
    serialized = json.dumps(observed)
    assert "PRIVATE-CORPUS-MARKER" not in serialized
    assert "private-fixture-key" not in serialized


async def test_repeated_read_is_counted_without_logging_arguments(tmp_path):
    from pi_engine import observe_sessions
    (tmp_path / "private-index.md").write_text("private tool evidence")
    observed = []
    async def observe(event):
        observed.append(event)
    async with provider(lambda _, n: response(tool=("Read", {"file_path": "private-index.md"}))
                        if n < 3 else response(text="done"), api="openai-responses") as (config, _):
        with observe_sessions(observe):
            async with client(tmp_path, config, FileTools(str(tmp_path), ["Read"], allow).tools()) as instance:
                await instance.query("Hello")
                await collect(instance)
                await instance.query("Hello again")
                await collect(instance)
    dispatches = [x["data"] for x in observed if x["kind"] == "tool_dispatch"]
    assert [x["consecutive_same_call"] for x in dispatches] == [1, 2]
    assert "private-index.md" not in json.dumps(observed)
    assert "private tool evidence" not in json.dumps(observed)


async def test_diagnostic_sink_failure_does_not_drop_tool_reply(tmp_path):
    from pi_engine import observe_sessions
    (tmp_path / "index.md").write_text("evidence")
    async def broken_sink(event):
        if event["kind"] in {"worker_start", "worker_ready", "tool_dispatch", "tool_result", "model_payload"}:
            raise RuntimeError("private failure text")
    async with provider(lambda _, n: response(tool=("Read", {"file_path": "index.md"}))
                        if n == 1 else response(text="done"), api="openai-responses") as (config, requests):
        with observe_sessions(broken_sink):
            async with client(tmp_path, config, FileTools(str(tmp_path), ["Read"], allow).tools()) as instance:
                await instance.query("Hello")
                assert (await collect(instance))[-1].data["outcome"] == "completed"
    assert "evidence" in next(x["output"] for x in requests[1]["input"] if x.get("type") == "function_call_output")


async def test_chat_completions_image_attachment_remains_visible_in_wire_summary(tmp_path):
    from agent_protocol import EngineTool
    from pi_engine import observe_sessions
    from test_pi_engine import completion
    observed = []
    async def observe(event):
        observed.append(event)
    async def image_tool(_):
        return {"content": [{"type": "image", "mimeType": "image/png", "data": "cHJpdmF0ZS1pbWFnZQ=="}]}
    tool = EngineTool("ReadImage", "Read a fixture image", {"type":"object","properties":{}}, image_tool)
    async with provider(lambda _, n: completion(tool=("ReadImage", {})) if n == 1 else completion("done")) as (config, requests):
        with observe_sessions(observe):
            async with client(tmp_path, config, [tool]) as instance:
                await instance.query("Read image")
                await collect(instance)
    actual = sum(1 for m in requests[1]["messages"] for c in (m.get("content") or [])
                 if isinstance(c, dict) and c.get("type") == "image_url")
    assert actual == 1
    context = [e["data"]["context"] for e in observed if e["kind"] == "model_request"][1]
    wire = [e["data"]["summary"] for e in observed if e["kind"] == "model_payload"][1]
    assert context["inlineToolResultImages"] == 1
    assert wire["inlineToolResultImages"] == 0
    assert wire["otherMessageImages"] == actual
    assert "cHJpdmF0ZS1pbWFnZQ==" not in json.dumps(observed)
