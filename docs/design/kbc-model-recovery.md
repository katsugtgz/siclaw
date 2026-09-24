# Live KBC model recovery

Compiler executions keep their model, endpoint, reasoning settings, tools and
checkpoint identity. Credentials are replaceable access material: updating the
key or credential binding on the same model must not require rebuilding the box.

When Runtime negotiates `credential_refresh` at session creation, model clients
use a loopback transport inside the box. It resolves the bound model's current
credential through the parent run's event channel, but a request only waits for
that when the provider rejected its credential (401/402/403). A static API key
is otherwise used as installed. A rotating subscription bearer
(`openai-codex-responses`) is also refreshed ahead, at most every 15 seconds and
in the background, so no request waits for it. Refreshes are single-flight per
model route and time out after 20 seconds. A failed or unanswered refresh keeps
the current credential, is counted per route and logged as
`kbc.model_credential.refresh_failed` with metadata only; for 15 seconds after
it, further rejections return without waiting for another refresh. Neither the key nor
the refresh response is forwarded to public events or persisted in run state.
The control plane validates the model's organization, ID, endpoint and protocol
before returning its current credential. Redirects are not followed.

Credential requests are control frames with their own box stream,
`GET /control-events/:runId`, advertised by `relay_ready.control_events`.
Runtime consumes it beside the ordered event relay, so a request is answered
even while an earlier artifact batch is still being persisted; the event relay
keeps its one-frame-at-a-time backpressure. Without a control consumer (an
older Runtime, or before it attaches) the box sends the request on the ordered
stream as before, and an older box never advertises the stream. An unavailable
control plane therefore cannot stall a model call for longer than one refresh
timeout, and only after a credential rejection.

A 401/403 is retried once after the refresh; a 402 only when the credential
changed. A transient 408/429/5xx is retried once without a refresh. When the
refresh after a rejection fails, the provider's own error is returned. Long
Retry-After delays are returned to the caller instead of bypassed. Only the
failed HTTP request is retried: SDK conversation state and completed host tools
remain intact. Partial streams and ambiguous connection failures are not
replayed. Owner-facing provider errors are preserved with rotated keys redacted.
No new deployment environment variables or dependencies are required.

## Artifact persistence refusals

Runtime retries one artifact batch until the consumer commits it, for at most
10 minutes. A permanent refusal (`CONFLICT`, validation, permission or missing
run) is not retried: Runtime reports that the platform refused the batch and
fails the run with `RelayArtifactRejectedError`, keeping work saved by earlier
batches. A test-session error frame forwards the box's validated `code`,
`failure_code` and `api_error_status` tokens to the consumer.

Interactive tests resolve the current configured test model separately from the
compiler snapshot. Each test session pins that model and consumer fingerprint.
Before a question is accepted, Runtime supplies the current test configuration.
If it differs, the box returns `kb_test_model_changed` without querying the SDK.
SiCore confirms closure of that old test session, and the browser opens one new
test session and submits the unsent question once. Prior conversations and
grades keep their original session/fingerprint; the new conversation starts
with the new model. Compilation in the parent box is unaffected.

Rollout requires the matching SiCore API/web change, Runtime and KBC image.
Deploy the SiCore support before Runtime. Existing boxes and SDK processes from
older images do not acquire new code automatically; allow those executions to
finish before replacing their boxes. An older consumer payload without model
binding IDs keeps its original transport until the coordinated upgrade.

## Failed authoring turns

A reusable conversation is distinct from a running authoring operation. Typed
compile actions, incremental updates and their repair turns retain their action
identity for that turn. A failed model result ends that operation with
`model_result_error` (or `quota_exhausted` for HTTP 402); an unrelated owner
conversation remains retryable. The persistent run's command-generation pin is
not used to classify a later conversation.

Before emitting the terminal failure, the compiler disconnects the model,
quiesces media/PK writers and sends a full workspace checkpoint. A stopping
fence is set before model disconnect or task cancellation can yield. It blocks
verification chaining, repair injection and convergence publication. A lifetime
task registry also tracks finalizers that have released their single-flight
slot but are still writing; all tracked writers are cancelled and joined before
the checkpoint. This includes files already queued by periodic synchronization. The failed checkpoint removes
the convergence completion marker and does not commit the source baseline, so
saving partial work cannot promote it as a successful draft. Existing check
findings remain available.

ACK-capable Runtime confirms the consumer's artifact transaction before failure
is emitted. ACK timeouts retain the same snapshot for relay replay instead of
allocating another full snapshot. Local save errors retain the workspace and
retry with an owner-facing notice. Older Runtime serializes artifact persistence
before consuming the failure frame. Consumer recovery keeps ownership of
backoff, quota suspension, generation fencing and stable-draft restoration.

This behavior applies to newly started boxes with the updated compiler image.
It does not reconcile historical operations already stranded by older boxes,
change explicit user-stop semantics, or replace the Runtime's existing liveness
and infrastructure-loss policies.
