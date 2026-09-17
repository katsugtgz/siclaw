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
