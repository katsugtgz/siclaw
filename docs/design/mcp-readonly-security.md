---
title: "Read-only MCP and pre-model output security"
description: "Shared Pi/Codex admission, credential redaction and native MCP transport boundaries."
---

# Read-only MCP and pre-model output security

## Required boundaries

The model is not an authorization authority. Shell execution retains the shared
command whitelist, path checks, credential broker and OS isolation. MCP admission
uses operator-owned exact allowlists. A server's `readOnlyHint` is presentation
metadata and grants no permission.

Binding an MCP server authorizes selecting its configuration. It does not grant
every discovered tool permission to execute. A server without an explicit policy
is not connected by the Agent runtime. Management connection probes may discover
an inventory, but produce no executable tool definitions.

## Configuration through the existing SiCore contract

Reserved entries in the server's existing `env` map hold the security policy.
This works for stdio, SSE and Streamable HTTP without another resource store,
database migration or frontend field. They are consumed by Siclaw and are never
forwarded to the MCP process or HTTP endpoint.

```json
{
  "transport": "streamable-http",
  "url": "https://monitoring.example/mcp",
  "headers": { "Authorization": "Bearer <credential>" },
  "env": {
    "SICLAW_MCP_READ_ONLY_TOOLS": "[\"query_metrics\",\"get_dashboard\"]",
    "SICLAW_MCP_READ_ONLY_RESOURCES": "[\"monitoring://status\"]",
    "SICLAW_MCP_READ_ONLY_PROMPTS": "[\"diagnose\"]"
  }
}
```

All lists contain exact names/URIs; wildcards and malformed policies grant
nothing. Resources and prompts are optional and default to unavailable. The
policy author must review each allowed operation and use read-only service
credentials. A generic SQL, shell or HTTP tool with a write mode is unsuitable
for this allowlist unless its backend independently enforces the reviewed
argument policy. Naming a tool `query` does not make its implementation safe.

The exact baked `sudo -E -u sandbox -- node <baked create-chart entrypoint>`
configuration has a reviewed default for `render_chart` and `render_mermaid`.
Arbitrary processes, arguments, HTTP server names and server-reported versions
cannot acquire this default.

Policy changes retain the existing session turnover/reload contract. The shared
configuration materializer remains the source of selected MCP resources.

## Native Codex transport

```text
Codex native MCP client
  -> authenticated, owner-scoped loopback MCP gateway
  -> exact operation admission
  -> selected upstream SDK client (stdio / SSE / Streamable HTTP)
  -> complete-result sanitization
  -> Codex model context and native events
```

Codex owns native discovery, execution, subagents and history. The gateway is a
protocol security boundary; it does not instantiate a Pi AgentSession or route
calls through Pi ToolDefinitions. Upstream Codex requires no source patch for
this boundary. Original endpoint credentials stay in the AgentBox backend;
Codex configuration contains only the loopback endpoint and private proxy auth.

The gateway binds `127.0.0.1`, requires a random bearer token, validates Host,
rejects browser Origins, limits request bodies and session counts, and closes
its transports with the owning brain. Requests cannot use another server's
session. It advertises only authorized tools with verified native call attribution.
External resource/prompt capabilities, catalogues and methods are not exposed,
even when the shared configuration selects them. Resource/prompt-only server
configurations do not establish an upstream connection or launch a process.
Unknown methods, subscriptions, tasks, sampling and elicitation
are not forwarded. Client progress/tracing metadata is consumed locally.
HTTP redirects are rejected, including SSE GET and POST requests.

## Native JS and per-operation authorization (2026-10-07)

Codex free-code execution uses its native JavaScript Code Mode, not a Pi
`run_script` wrapper. The adapter does not initialize the disposable Python/Bash
runner for Codex. Existing reviewed Skill assets remain a separate capability;
this does not add unrestricted shell or interpreter execution.

```text
Native JS tools.mcp__<server>__<tool>(arguments)
  -> Codex native MCP client
  -> private loopback gateway / live owned native item
  -> AgentBox GatewayClient / Runtime mTLS identity
  -> Runtime current Web caller + control-plane session authorization
  -> current shared Agent MCP bindings and configuration
  -> exact operator tool and argument policy
  -> selected upstream SDK client
  -> authorization recheck + pre-model sanitization
  -> native JS / model / SiCore events
```

Code Mode receives tool schemas and sanitized results, never the upstream URL,
headers, env, OAuth token or API key. Proxy authentication is only transport
authentication: it grants no tool authority. The native item binds server,
tool, arguments, thread and turn. Unknown calls, caller-supplied identities,
substituted arguments, replay, ended turns and unavailable authorization fail
closed. Native children inherit the owning public session's verified caller;
they cannot manufacture another public session or actor.

`POST /api/internal/mcp-authorize` accepts only a trusted `session_id` and an
operation descriptor. Runtime derives Agent/box identity from its existing
certificate and the user from the live authenticated Web turn, not from model
arguments or historical session ownership. Existing `sandbox.resolve` with an
empty source verifies the upstream session/user/access; `config.getResources`
and `config.getMcpServers` retain the one shared tenant/product/preview resolution
pipeline. No new resource store, DB migration or credential export API is added.
Standalone Portal retains its administrator-owned Web-session restriction.

The private permit contains only actor IDs and digests binding the exact
operation, approved arguments, configuration and policy. It is not a durable
grant or a model-visible result. Authorization is performed before dispatch and
again before result delivery. Binding revocation, credential/configuration
rotation, changed caller, cancellation and policy changes suppress the result;
stale transports are never silently reused under a new grant. A changed
configuration requires ordinary session rebuild. Stop aborts active MCP
transports as well as permission checks. Each owning gateway allows at most ten
simultaneous tool calls; this is not a distributed per-target traffic quota.

Only attributable native tool items are supported by this dynamic gate today.
External resource/prompt reads fail locally with MethodNotFound and zero upstream
dispatch until they have their own verified native caller/attribution contract.
Allowed tool results may still contain sanitized embedded text resources; that
does not grant a new `resources/read` operation. Existing shared policy keys and
Pi behavior are unchanged. Non-Web callers still require their own verified
caller/admission contract.
This is an intentional security restriction, not equivalent acceptance of every
legacy entry point. Intrinsic knowledge/workflow services retain their separate
owned-turn contracts. Pi remains separately selectable.

### Operator argument scopes

The optional reserved `SICLAW_MCP_OPERATION_POLICY` uses the existing server
`env` configuration channel and is consumed only by Siclaw. It is never forwarded
to the server. A present v1 policy is authoritative over the legacy name list:

```json
{
  "version": 1,
  "tools": {
    "query_metrics": {
      "effect": "read",
      "fixedArguments": { "/tenant": "team-a" },
      "allowedArguments": { "/target/namespace": ["production-a"] }
    },
    "restart_workload": { "effect": "write" }
  }
}
```

Constraints use exact JSON pointers and typed JSON equality. Missing fixed fields
are injected by the trusted proxy; caller overrides are refused. Scoped fields
must be present and match one of their explicit values. Wildcard tool names,
unknown versions, malformed policies, executable expressions and prototype
paths grant nothing. Pi and Codex reuse the argument evaluator. Legacy exact
read-only lists remain supported when no v1 operation policy is configured.

Pi and Codex path-check the final effective arguments after fixed-value injection
as well as the original request. Fixed routing configuration never grants private
credential/system-file access. Configured argv authentication values register
their Bearer/Basic, URL and password fragments in the shared secret source so an
upstream echo cannot evade redaction by omitting the enclosing flag/header.

These scopes constrain only explicitly reviewed argument fields. They do not
infer the semantics of arbitrary SQL, shell, HTTP proxy or code-execution tools.
Fixed scope data must be non-secret routing values, not credentials. Reviewed
atomic implementations and least-privilege upstream credentials remain required.

### Future writes

V1 parses an operator `effect: "write"` declaration but never advertises or
executes it, even if the MCP server claims `readOnlyHint: true`. Enabling writes
requires a separate control-plane authorization/approval contract, not removing
this deny or trusting Codex's transport approval setting. Bind that future grant
to current user/role, Agent, immutable server/resource identity, target fields,
exact approved argument digest, native call identity, policy revision, expiry
and single use. Re-authorize after queueing; track dispatched/finished/unknown
outcomes and never automatically replay a write after transport loss.

Permission audit records currently contain decision, effect, actor/session,
server/tool, call identity and argument/policy digests. They do not include code,
raw arguments, endpoints, headers, env, credentials or upstream error messages.
This is the governance extension boundary; a write-approval UI, role-policy
editor and durable write receipt are not implemented by the read-only v1 gate.

### Native security evaluation gates

These evaluate the transparent authorization boundary, not the quality of
external business tools. Use fixed protocol fixtures plus real Web-control-plane
acceptance; do not infer production MCP correctness from a fixture.

| Case | Required result |
| --- | --- |
| Native JS aggregation invokes an allowed MCP | Native Code Mode executes; sanitized result reaches JS |
| SDK discovery reports a secret or spoofed read-only writer | Secret absent; writer not callable |
| Actor/session substituted in the request | Refused before upstream dispatch |
| Native call ID replayed or arguments substituted | Refused by owned-item attribution |
| Fixed tenant omitted or overridden | Trusted injection or refusal; no caller override |
| Namespace outside the explicit argument scope | Refused; upstream execution count unchanged |
| Server unbound/disabled or credential/configuration rotated | Current lookup refuses the stale snapshot |
| Caller ends/changes while permission lookup is pending | Refused; no stale caller permit |
| Authority revoked after upstream response | Result withheld; operation not automatically repeated |
| Stop, source loss or transport failure | Bounded cancellation; unknown outcomes not replayed |

## Pre-model sanitization

Pi and native Codex reuse the same MCP policy and result sanitizer. Sanitization
occurs before the runtime engine receives a result, not merely before the UI
renders it. It covers discovery descriptions/schema values, text, embedded text
resources, structured content, resource reads and prompt messages. Upstream
exceptions are replaced with a fixed safe error. Server instructions, metadata,
icons and links are not blindly forwarded.

Owner-scoped secret sources include configured model/MCP credentials and cluster,
host and bastion credentials acquired through the shared CredentialBroker.
Values acquired after session construction participate in the next output gate.
Rotated values remain registered until that owner is disposed. There is no
process-global cross-user secret registry.
An owner process restarted with existing private credential files registers
them before accepting output. Cache symlinks and excessive cache contents fail
closed; startup does not scan another user's directories.

Known literals are matched regardless of length or placeholder shape. Matching
covers raw, JSON-escaped, percent-encoded, base64, base64url and hex forms, including
Basic-auth decoded password values. Existing structural secret/resource and
generic text redactors remain in use. Complete documents are processed before
projection, truncation, artifacts and model delivery. Ordinary tool progress
content is withheld until a complete sanitized result is available.

Unknown opaque image/audio/blob/link content is suppressed. Only the reviewed
baked renderer may return images after its inputs have been sanitized. Arbitrary
filesystem image viewing is disabled; scoped text reads remain available.
Malformed or oversized results and sanitizer failures return a suppression
error, with no raw fallback. MCP results have an 8 MiB output budget; discovery
has page, item and byte limits.

Pi file reads use canonical paths, deny credential/config/agent-state roots and
do not grant access to the entire system temporary directory. Symlinks cannot
turn a workspace read into a credential read. Its invocation-scoped output
context applies the live secret gate before command projection/truncation;
the artifact store applies it again before hashing or persistence. Native
executor stdout/stderr and text filesystem responses have equivalent gates,
including private infrastructure IPC and native child execution.

Pi scripts, native Codex scripts and dynamic MCP arguments also reuse the
existing command policy's sensitive paths and glob matcher. Private broker
directories, normalized paths, file URIs, encoded paths and local symlink
operands are checked before invocation. An approved script asset is not a
permission to pass it `/etc/shadow`, service-account tokens or private config.
The reviewed renderer treats its input as display data and retains its separate
sanitized-input contract.

## Trust limits and acceptance

Reviewed Skill scripts retain the existing Pi trust boundary: immutable selected
assets may execute as the credential owner. Review and least-privilege target
credentials remain necessary; an arbitrary approved program cannot be proven
read-only by a shell command whitelist. The model cannot submit inline programs
or change those approved bytes. This work does not redesign native memory or
its deferred isolation work.

Pattern matching cannot recognize every unknown credential or arbitrary hostile
encoding. Rejecting secret-file access, requiring reviewed read-only operations,
restricting credentials and suppressing opaque/unprocessable outputs are the
primary controls. The redactor is an additional pre-model boundary. It does not
retroactively remove data that a previous runtime already disclosed.

Verification includes real SDK protocol tests with a spoofed read-only write
tool, exact-secret/encoded/error/structured-content fixtures, canonical-path and
artifact tests, and `scripts/test/codex-mcp-security-smoke.mjs`. The smoke uses the
pinned source-built Codex, records actual Responses request bodies, tests parent
and native child calls plus resume, and checks that upstream write execution is
zero. Test credentials and raw private logs must not be included in reports.

### Accepted on 2026-10-06

- Source implementation: `9d76db98b38a458d2b674e6ae6ad81018e897d6c`.
  Official source-built Codex remains pinned to `d4684bba`; no additional
  upstream patch or production dependency was introduced.
- Full regression: **418 files / 8731 tests**; TypeScript check and build pass.
  Linux production-image tests cover native MCP parent/child/resume model
  request bodies, native session/plan/command/file/Stop behavior, and selected
  local/SSH/Pod Skill scripts with immutable grants and process-tree Stop.
- Deployed only through the independent `siclaw-native-validation-runtime`
  in `roce-test` / `sicore-test`. AgentBox image is
  `registry-cn-shanghai.siflow.cn/k8s/siclaw-agentbox:codex-security-9d76db98`,
  digest `sha256:84c812b35584a6a9d75bbd8aa845283a0726c638b188fe9a3fc915118c6c8a6b`.
- Real SiCore Responses acceptance session:
  `0ec98301-2f8d-41af-aba1-267a83115eda`; native child:
  `f18145bf-1be3-477f-8793-08c575908035`.
  MCP normal/error results, bound-cluster Pod queries and existing script help
  work. MCP sensitive-path arguments, Kubernetes deletion, private config
  reads and sensitive script operands are rejected. An additional disallowed
  `sed` attempt was also rejected before the model used an allowed file read.
- Upstream fixture counter: **3 read calls, 0 write calls** (parent normal,
  parent error and child normal). The sensitive MCP request never reaches its
  upstream handler. Parent SSE and persisted parent/child messages contain no
  fixture credential. Reserved policy env values are not forwarded upstream.
- Original test Agent resource bindings are restored. Temporary MCP registration
  and counter are removed. Reader permissions remain namespace Pod get/list/watch;
  no node, Pod-exec or diagnostic-Job permission was added for this acceptance.
  The independent Runtime keeps the verified AgentBox image for follow-up work.

The live SiCore run verifies real routing, brokering, events and persistence.
Exact model-request-body checks use the deterministic source-built Codex smoke;
the live external provider's encrypted HTTP traffic is not captured.

### Native JS / dynamic authorization acceptance (2026-10-07)

- Implementation `7aad3f55824a2aeb480f339b2c4d4d4ef528a607`; Codex remains
  pinned to `d4684bba`. No Rust patch, production dependency, DB migration or
  Pi runner bridge is added. Full regression: **426 files / 8793 tests**,
  TypeScript and build pass.
- Source-built deterministic MCP parent/child/resume checks pass with 14
  Responses requests and zero upstream writes. Linux native Code Mode executes
  JavaScript calling the native MCP tool through owned-item attribution; fixed
  tenant injection, namespace/tenant override denial, model-body credential
  absence and zero write execution pass. This JS test uses a deterministic
  provider; it is separate from the real-provider Web acceptance below.
- Shanghai builds derive from the previously accepted source-built Codex image;
  only compiled Siclaw code is replaced. Independent test AgentBox digest:
  `sha256:37f2c9138e80e1f134e02a989fe957536d8a88636ebef3163d7dae10644500a5`.
  Runtime digest:
  `sha256:e57f8ac8604b7e85090cb4dccd606f29a6ef9fa2e8b00bf30279caaba3b57f1c`.
- Actual `sicore-test` SiCore, Runtime, AgentBox mTLS and `gpt-5.6-luna` without
  fallback pass in session `42eb821e-dea4-4d6c-b388-0e8e432ea6c2`. The temporary
  stdio MCP is a protocol/security fixture, not a production business backend.
  It receives `tenant=team-a`, `namespace=sicore-test` and no reserved policy env.
  Out-of-scope namespace and fixed-tenant override are refused; only one read
  reaches the fixture, and no writes. Runtime records matching caller/session,
  operation and argument/policy digests before dispatch and before delivery.
  SSE and persisted messages contain no fixture credential.
- Live revocation passes in `493bb4af-c332-4ca1-a5a9-cfc048fab763`: after a
  successful read, the native turn waits for a real clarification/steer. The
  control plane removes its binding while that same turn remains active. A
  second invocation of the cached native tool is refused. The combined upstream
  count across these two accepted scenarios is two reads and zero writes.
  An earlier malformed test call used `label` instead of `namespace`; it was
  correctly refused and did not count as a successful revocation baseline.
- Original cluster/host/MCP bindings are verified/restored; the exact temporary
  MCP registration is deleted. Histories and audits remain. Test API and Runtime
  are Ready 1/1; normal SiCore API/Web still use their original `memui18` images.
  One transient etcd/exec/port-forward failure recovered through read-only checks;
  it was not a policy bypass or permission fallback.

This establishes the read-only v1 boundary, not production business-tool safety,
write authorization, a policy-management UI, all non-Web entry points or external
resource/prompt attribution. Keep write rules unavailable pending a separately
reviewed approval/durable-outcome contract.
