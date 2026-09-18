# Live KBC model recovery

Compiler executions keep their model, endpoint, reasoning settings, tools and
checkpoint identity. Credentials are replaceable access material: updating the
key or credential binding on the same model must not require rebuilding the box.

When Runtime negotiates `credential_refresh` at session creation, model clients
use a loopback transport inside the box. Before an upstream request it resolves
the bound model's credential through the parent run's existing event channel.
Successful refreshes are cached for 15 seconds and concurrent refreshes are
serialized. A refresh times out after 20 seconds. Neither the key nor the
refresh response is forwarded to public events or persisted in run state.
The control plane validates the model's organization, ID, endpoint and protocol
before returning its current credential. Redirects are not followed.

An explicit 401/403 or transient 408/429/5xx response can be retried once after
refreshing credentials. A 402 is retried only when the credential changed.
Long Retry-After delays are returned to the caller instead of bypassed. Only the
failed HTTP request is retried: SDK conversation state and completed host tools
remain intact. Partial streams and ambiguous connection failures are not
replayed. Owner-facing provider errors are preserved with rotated keys redacted.
No new deployment environment variables or dependencies are required.

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
