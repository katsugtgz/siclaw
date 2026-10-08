# Codex controlled infrastructure execution

## Native boundary

Use native `exec_command` and `write_stdin`, including native child calls. The
official source-built exec-server owns process start, polling and termination.
No Pi ToolDefinition/AgentSession or host_exec/node_exec/pod_exec tool bridge is
installed in Codex. Existing credential, SSH and diagnostic Job services are
transport infrastructure and remain independent from the agent engine.

- `cluster:<bound name>`: native read-only kubectl API queries.
- The same environment supports authorized `kubectl -n <ns> exec <pod>
  [-c <container>] -- <approved diagnostic command>` and `kubectl debug node/<node> --
  <approved diagnostic command>` syntax. Namespace/container flag ordering is accepted.
- `siclaw`: `ssh <bound host name or id> -- <approved diagnostic command>`. A shared
  transport avoids one native runtime per host. Broker-owned bastions and
  authentication are resolved internally. The model cannot supply SSH options,
  identities, credentials or forwarding.

### Host tools in a Pod network namespace

Native execution also admits these logical selectors:

```text
exec_command(environment_id="cluster:<bound-name>", cmd="kubectl -n <namespace> debug pod/<pod> [-c <container>] -- <approved diagnostic command>")
exec_command(environment_id="siclaw", cmd="ssh <bound-host> --pod <pod> --namespace <namespace> [--container <container>] -- <approved diagnostic command>")
```

The cluster form requires **node diagnostics**, not ordinary Pod exec/API access.
It reuses Siclaw's Pod-to-node/CRI netns resolver and the operator-owned node
helper; it never adds an ephemeral container to the target Pod. The SSH form
requires host diagnostics; the bound host must run the selected Pod and its
account must permit CRI/netns access. Names and optional container selectors are
validated before transport. CRI name/namespace regex filters match exact names.
The selected container is checked on the cluster path; the netns itself belongs
to the Pod sandbox, shared by all containers.

Only the backend supplies `ip netns exec` and the resolved namespace name.
Model-authored raw netns/nsenter commands, helper images, credentials, transport
options and inline code remain denied by the existing policy. Resolution errors,
host-network Pods, stopped turns and revoked bindings fail closed; they never
silently run the diagnostic in the host namespace. Node helper setup and
resolution retain the prepared-namespace and host-root/cwd restrictions.
The process-group record stays in the host namespace so native Stop can reap
the selected command without needing a model-supplied netns handle.

Reviewed immutable node/host Skill scripts support the same selectors with
their separate script grants and sealed stdin; no free Python/Bash code is
enabled. Adapter instructions advertise these selectors without editing
`src/core/prompt.ts`. Component/SSH protocol fixture checks are distinct from
real Linux Pod-netns deployment acceptance; earlier live infrastructure evidence
below does not certify this new path.

## Authorization

Capability booleans come from the current Agent harness. API, node, Pod and SSH
access are independent grants. Native process requests cannot overwrite broker
environment, select another kubeconfig/context/identity, provide interactive
input, choose a diagnostic image or create arbitrary remote filesystem writes.
Remote commands use the same Siclaw command registry, context policy, semantic
flag validation and sensitive-path checks as Pi. There is no Codex-specific
command name allow-list. The deployment's additive-only extra-command config
applies to both engines, including its constraints and built-in collision rules.
An approved binary still needs to exist on the selected target.

Whitelist compatibility includes existing Pi network probes and controlled
benchmarks. These operations can consume resources or generate traffic; the
shared diagnostic policy is not a guarantee that every permitted operation is
passive. Arbitrary filesystem writes, mutating command flags, Kubernetes API
mutations and unapproved binaries remain rejected. Pod commands retain Pi's
single-command restriction; node and SSH commands may use validated pipelines.
Native transport separately rejects environment/identity overrides, interactive
input and executable paths outside standard system directories unless the
shared deployment config explicitly lists that vendor binary's canonical path.
The shipped GPFS query permits `/usr/lpp/mmfs/bin/mmlscluster`; unconfigured
locations and temporary lookalikes remain denied. These execution boundary
restrictions do not add another command registry.

Both engines' shared output pipeline redacts complete generic diagnostic stdout
when no command-specific sanitizer applies, before JSON projection, artifact
capture or model delivery. Generic reads such as `curl`, `cat` and `zgrep` must
not rely on later UI/persistence redaction. Existing structural sanitizers keep
their JSON projection contract and separately report data-mode notices.

Each launch refreshes the current bound inventory and acquires current
credentials. Removed targets fail closed. Pod/node GET authorization selects
the exact named target before remote execution. Kubernetes RBAC remains
authoritative; granting Pod exec requires the transport subresource permission,
even when the executed diagnostic command only reads state.

## Transport and isolation

Validated native commands (local and remote) become one-use, expiring tickets on a loopback-only
service. The native exec-server launches a fixed transport client under the
existing sandbox UID. The service owns credentials and executes the sealed
operation. Ticket holders cannot alter the operation. Local diagnostics retain
the existing sandbox UID and sanitized environment; reviewed scripts retain
their separate service-identity trust boundary. Only sanitized bytes cross the
private streaming IPC boundary into the native exec-server.

Target commands have no adapter runtime deadline; native termination and
transport disconnect propagate cancellation. Remote channel failures also
request cleanup of the selected remote session. Node diagnostics use the existing
platform-owned diagnostic Job lifecycle, image and namespace, with existing
deadline/cache cleanup. Creating a diagnostic helper is a controlled platform
operation; it does not grant model-authored Kubernetes mutations or host writes.
The native node path requires an already provisioned namespace and never creates
a namespace. An explicit operator `SICLAW_DEBUG_IMAGE` pin takes precedence over
the bound cluster's diagnostic image and the default image. The model cannot
override either. Node commands enter the host's root and cwd as well as its
mount/UTS/IPC/network/PID namespaces.

Infrastructure cancellation is bound to the native process ID within its
owning executor connection. After policy admission, `process/signal` and
`process/terminate` abort that sealed operation directly; native exited/closed
notifications also terminate any still-running transport work. HTTP disconnect
remains a complementary trigger, not the only one. A stopped, unclaimed ticket
is invalidated before it can launch. This keeps reconnect ownership unchanged
and stores no process output or second job ledger. Fresh remote session cleanup
still uses the existing broker-owned SSH/Kubernetes transport and exact PGID
record; unavailable transports remain a best-effort reaping limitation.

Product Stop additionally cancels every active sealed operation in that
public conversation's Brain-owned relays, including its native children and
already-yielded process handles. Upstream turn interruption alone only cancels
the model/polling wait and is not this guarantee. Stop pauses new native
process launches, invalidates pending tickets and reaps owned local sessions;
only a newly admitted user prompt reopens launches. Other public conversations
have separate relays/credentials and are not affected. Silent SSH cancellation
also destroys local output readers and releases the SSH chain without requiring
the peer's channel-close acknowledgement.

Pi's existing namespace initialization also accepts a prepared namespace when
creation is forbidden but its existence can be verified by GET. If neither
creation nor verification succeeds, the original initialization error remains.
This does not grant namespace creation to a read-only diagnostic account.

Codex prompt assembly omits Pi infrastructure tool-name guidance while keeping
the same SRE capability grants and operational safety. Native environments and
SSH syntax are supplied as application instructions alongside Codex's own base
instructions. `src/core/prompt.ts` is unchanged.

Whitelist command control does not change the remote account's OS privileges.
Use appropriately scoped SSH accounts and Kubernetes credentials. Unsupported
native filesystem or interactive contracts must fail closed.

## Native long processes and output

The relay forwards native `process/output`, `process/exited`, `process/closed`
sequence numbers and `process/read` unchanged. Official exec-server owns replay,
retention, long polling and stream closure; Codex unified exec owns yield time,
`write_stdin`, token budgeting and head/tail truncation. No Siclaw output ledger,
synthetic sequence, whole-process 8 MiB buffer or default 60/180/300-second kill
exists. Private keepalive frames prevent HTTP transport idle timeouts and never
become model-visible output. Explicit approved-script `timeout` remains optional.

The owner-scoped stream security gate holds incomplete text records and JSON
structure, and carries PEM, YAML scalar/mapping and environment state across
chunks. Known credential literals and encodings are held across byte/line splits.
Stdout and stderr have separate framing state. A complete safe text line is
available while the process runs; structured JSON is available after its closing
boundary. Malformed UTF-8 or a failing secret source suppresses the affected
stream. A malformed/incomplete or oversized record is suppressed; it neither
terminates the process nor removes subsequent safe records. The individual
record redaction budget is 8 MiB. This security framing is independent of native
whole-process output/token limits. Full-log archiving/search is a separate
product feature and is not required for native runtime compatibility.

On 2026-10-07 the user deferred improving large structured-record completeness.
Keep the existing record budget/suppression behavior until that follow-up is
resumed. The recorded goal is incremental structural redaction before native
truncation, not removal of the pre-model safety gate; see
[Deferred follow-ups](codex-native-runtime.md#deferred-follow-ups).

## Acceptance

Require native source-built positive reads and negative writes for all four
targets, current broker/SiCore bindings, removed-target denial, sensitive output
redaction and cold child continuation. Separate SSH protocol fixtures from
actual deployed SSH/Pod/node evidence. Test Kubernetes changes remain in the
authorized `roce-test` / `sicore-test` environment.

### Shared whitelist compatibility (2026-10-06)

The engine-specific remote command list is removed. Differential checks cover
all 155 built-in command names across Pod, node and host contexts, representative
safe and unsafe flags, sensitive paths, output sanitization, pipeline behavior,
the deployment's actual extra-command config, additive-only collisions and extra
command removal. Pi execution code is unchanged. The native adapter retains its
noninteractive transport and executable-path boundaries.

412 test files / 8677 tests, TypeScript and build pass. The pinned source-built
exec-server plus real SSH protocol fixture admits `curl`, the deployed `sichek`
extra and `printenv`, refuses mutating flags and removed extras, sanitizes output
before delivery and rejects a revoked binding. The protocol fixture returns
fixed output; it does not establish target-side binary availability. This
whitelist update is source/local verification, separate from the older deployed
image and cluster evidence below.

### Actual test-cluster evidence (2026-10-06)

#### Shared-policy rollout and final executor comparison

Source `84cbabef` passes 413 files / 8693 tests, TypeScript, build and the pinned
official source-built exec-server SSH smoke, including Linux image execution.
The independent test Runtime now selects
`codex-whitelist-test-84cbabef`, digest
`sha256:1f13d64f51fe8d157a25e58178e83a875d92d5de4d9d34a1d08d3ef960428809`.
The Codex source pin and Runtime binary remain unchanged.

Actual Responses/SiCore/K8sSpawner acceptance on this image persists 14 successful
native executions and seven policy refusals. Reads include actual node
`sichek gpu` and `/usr/lpp/mmfs/bin/mmlscluster --noinit`, Pod/SSH `curl` and
`zgrep`, Pod environment redaction and SSH UID 2001. Both the SSE stream and
persisted messages exclude the fixture secret. The node has no NVIDIA GPU;
`sichek` reports the corresponding health check bypass rather than proving GPU
diagnostic functionality. Refusals include writes, unsafe curl flags, daemon
startup, an untrusted executable path and Pod pipelines. Removing the SiCore SSH
binding then denies an actual new native call in the same conversation.

The original Pi executors run as the image's agentbox user against the same
mTLS/broker/reader and fixtures: six reads succeed and four unsafe calls are
blocked, with generic stdout already redacted. This is executor-level evidence,
not a second Pi model conversation. Pi's node call explicitly selects the same
approved internal diagnostic image; its old default image is not pullable in
this test environment. The comparison exposed and fixed the generic stdout
sanitization and prepared-namespace permission gaps in shared services.

Native child, cold continuation and SiCore UI checks on the first shared-policy
image (`296ca90e`) pass: the owned child has two successful reads and one refusal;
Pod UID changes while native thread ID stays the same; child output can be
expanded and reopened after refresh. A separate ordinary UI conversation passes
Stop HTTP 200, continuation and refresh with no page errors. A later continuation
in the negative-policy-probe conversation returned provider `content_filter`;
that refusal is recorded separately from UI/Stop acceptance. The final source
delta does not change native lifecycle or UI code.

The original Agent bindings and reader Pod get/list/watch Role are restored.
Temporary node ClusterRole/Binding, SSH Pod/Service/ConfigMap and SiCore
host/credential are removed; private fixture key/token files are deleted.
The reader can no longer create Pod exec or Jobs or get the selected node, and
no diagnostic Job/Pod remains. The independent Runtime, latest AgentBox image
configuration and existing PVC remain for subsequent acceptance work.

This establishes the scoped infrastructure and lifecycle checks above. Knowledge
citations, attachments, reports, scheduling and reviewed script execution retain
their separate business-contract acceptance work; this is not a claim of full
Pi feature replacement or physical-host/multi-bastion SSH acceptance.

#### Earlier native read-only rollout

Source `473677a5` passes 411 test files / 8089 tests, TypeScript and build. The
official source-built exec-server with a real SSH protocol fixture verifies
broker-owned authentication, read-only rejection, removed binding denial and
sanitization before private IPC.

The independent Runtime uses `codex-infra-test-473677a5` (digest
`sha256:2e086b545f06290bf9ba9e9230b68c979f56b4a088a1c9aac770e64dcf31093f`).
This test-only image fixes helper namespace `sicore-test`, an internal reviewed
debug image, a 120-second helper deadline and five-second idle cleanup. The normal
production image keeps operator configuration. Codex's pinned GitLab source
commit is unchanged; these changes do not require another upstream patch.

Actual SiCore API, broker, Responses model and K8sSpawner produce 11 persisted
native command rows: six successful reads and five refusals. Reads include Pod
JSON, Pod kernel, node hostname `nodepool-062`, the node's Ubuntu 22.04.4 host
`/etc/os-release`, SSH UID `2001` and the SSH kernel. Refusals include API Pod
delete, Pod file creation, node sysctl writes, SSH file creation and an unbound
SSH host. The SSH target is an isolated real OpenSSH Pod with a readonly account
and readonly root filesystem; this is not a claim of physical-host SSH or
multi-bastion deployment acceptance. Existing SSH chain services/tests are reused.

The native V1 child performs the same broker SSH and Pod reads and receives a
pre-execution write refusal. Its actual child transcript has two successful tool
rows and one refusal. After deleting/recreating only the test AgentBox, the Pod
UID changes and native thread ID remains the same; SSH/Pod reads and write
refusal still pass. No Pi execution session participates in either check.
Revoking the actual SiCore SSH binding then makes the same native conversation
refuse further access. The cluster binding remains unchanged. All attempted
write-marker files are absent on the fixture target.

The user explicitly approved temporary Pod exec/helper Job permissions and
read access only to the selected node. Do not retain the temporary permission
expansion or SSH fixture after acceptance. Raw keys, tokens and transcripts live
only in the private validation directory, never in this repository.
After acceptance, the test reader's namespace Role is restored to Pod
get/list/watch only, its temporary node ClusterRole/Binding is removed, and the
SSH Pod/Service/public-key ConfigMap plus the private SiCore host/credential are
removed. Diagnostic Jobs/Pods finish cleanup; the existing Runtime and PVC remain.

### Native process and streaming acceptance (2026-10-07)

Implementation `ae4ff48e` keeps the official source pin `d4684bba` unchanged.
The process output ledger and default adapter deadlines are removed. Native
exec-server owns sequence numbers, replay, retention, closure and cancellation;
Codex owns yield/poll behavior and output token/head-tail budgets. Security
framing is applied before bytes enter that native process stream.

- Full regression: **418 files / 8748 tests**, TypeScript and build pass.
- Shared document primitives cover complete Pi/file/MCP documents and native
  streams: PEM, YAML mappings/scalars, quoted/folded/continued values, Pod env
  name/value pairs, registry auth, nested Secret objects and JSON records.
  Known owner credential literals/encodings are protected across byte/line
  splits. Malformed or oversized records are suppressed independently; a
  formatting expansion also respects the record budget.
- Linux validation uses the immutable, previously verified source-built Codex
  parent `codex-security-9d76db98` at digest
  `sha256:84c812b35584a6a9d75bbd8aa845283a0726c638b188fe9a3fc915118c6c8a6b`
  and compiles the current AgentBox TypeScript. No npm Codex is installed.
  The repository's full-source `Dockerfile.agentbox` remains unchanged.
- Actual lifetime probes on the unchanged transport (`749781af`) confirm a
  command beyond 60 seconds and a reviewed script beyond 300 seconds. A private
  HTTP keepalive prevents idle transport deadlines without becoming model
  output. Final `ae4ff48e` Linux image passes all five source-built native MCP,
  brain, script, stream and executor smoke gates, including >8 MiB safe logs,
  native replay/sequence, separate connection ownership, sandbox UID **1001**,
  immutable scripts, denied stdin and complete process-tree Stop. Model-request
  fixtures verify pre-model credential redaction and zero upstream MCP writes.
- Real SiCore/Responses/K8sSpawner run on `749781af` uses session
  `8bf1ad16-66ce-4aa6-81a6-6937f348c157`: the 75-second bound-cluster read exits
  zero, reviewed script help succeeds, deletion/private-file reads are refused,
  and native child `be8505bc-dc66-4364-956e-f392e098d614` performs an actual read
  with native spawn/wait/close. The native rollout records **3 write_stdin calls**.
  A first run surfaced an expired test token; refreshing the same reader
  credential fixes it without changing permission grants.
- Cold restore and Stop on `a1305f01` retain that same parent/child history.
  Stop session `c1776153-4ec4-4ca8-a94e-899c8e9bdbac` is acknowledged through
  SiCore; the earlier Stop's long sleep descendants are confirmed gone.
  Parent/child SSE and persisted records exclude the fresh reader credential.
- The independent `siclaw-native-validation-runtime` now selects final image
  `codex-stream-validation-ae4ff48e`, digest
  `sha256:325d4106126d09dafedf242a00cdac5ccb7d548d0db569c02553b77d07440198`.
  Final shared-redactor changes have Linux/component evidence; the live
  conversation evidence above names its exact deployed revision separately.
  Frontend, SiCore code and upstream Codex source are unchanged in this work.
- Original bindings remain one cluster and no hosts/MCP/extra Skill/Knowledge
  bindings. Reader RBAC remains only namespace Pod get/list/watch. The temporary
  local token file and redundant source rebuilds are removed/stopped. The test
  Runtime, Agent and its private PVC subdirectory are kept for follow-up runs.

This verifies the native long-process/output migration and its security gates.
Full raw log archival/search, executor reconnect, Portal UI, cross-Agent handoff
and the separately deferred native-memory isolation are outside this acceptance.
