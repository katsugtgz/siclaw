# Diagnosing KBC startup and repeated tools

KBC execution observations are metadata only. Group them by run, `session_id`,
`turn_id`, and model `call`; do not infer progress from Runtime `idle` alone.
These diagnostics do not change retries, tool execution or publication gates.

## Startup and health

- `worker_start` → `worker_ready.duration_ms`: actual Pi process/session setup.
- Container logs `kbc.test_snapshot.start` → `kbc.test_snapshot.complete`:
  snapshot installation duration and page count, before the test SDK starts.
- `kbc.event_loop_lag`: Python's event loop resumed at least one second late.
  Reports at most once every 30 seconds. Correlate with snapshot timestamps and
  probe failures. It proves scheduling delay, not whether CPU starvation, disk
  I/O or synchronous Python code caused it. It cannot report during a permanent
  freeze or after a process has been killed.

A container becoming Running does not mean the test snapshot or SDK is ready.
Snapshot start without completion also covers rejection/exception; inspect the
corresponding request error. Do not interpret it as a successful installation.

## Tool result → model request

1. `tool_dispatch`: tool name/call ID and `consecutive_same_call` (same name and
   canonical arguments; counter resets each turn). No arguments or fingerprint
   leave the host. Repetition is evidence, not proof of a loop: polling can be
   legitimate and is not automatically terminated.
2. `tool_result`: host completion time, error flag, text characters and image
   count. This precedes transport to the worker; it does not prove delivery.
3. `model_request.context`: SDK stream-boundary counts before input guards and
   provider serialization.
4. `model_payload.summary`: final provider payload counts after SDK conversion
   and payload hooks, on **every** model call. Reports function/tool calls,
   results, results paired to a call ID, result text volume, and two image counts:
   `inlineToolResultImages` counts images inside tool-result records;
   `otherMessageImages` counts images elsewhere, including SDK-created user
   attachments and actual user images. Chat Completions relocates tool images,
   so a decrease in the first count does not establish image loss. Do not
   attribute the second count to tools without inspecting authorized evidence. No tool
   arguments, body, URLs, headers or call IDs are included in these summaries.
   `format=unsupported` is not evidence of missing results. Current wire
   summaries cover Responses, Chat Completions and Anthropic message layouts.
5. Existing `model_usage`/assistant events give network timing and stop reason.

Host result present but no next request localizes the wait before the next
model dispatch. Results present in SDK context but absent in a supported wire
summary implicate conversion/guards. Results present and paired on the wire
rule out local omission at that boundary; they do not prove what a proxy or
provider accepted, nor that the model followed the result. Token usage alone
cannot prove omission: cached input and provider accounting can differ.

The real-worker Responses fixture checks result content at a local HTTP server
and compares observations against that request. It does not reproduce a live
provider's behavior or certify that a production loop is fixed.
