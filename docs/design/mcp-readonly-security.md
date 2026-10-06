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
session. It advertises only the authorized tools and explicitly selected text
resources/prompts. Unknown methods, subscriptions, tasks, sampling and elicitation
are not forwarded. Client progress/tracing metadata is consumed locally.
HTTP redirects are rejected, including SSE GET and POST requests.

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
