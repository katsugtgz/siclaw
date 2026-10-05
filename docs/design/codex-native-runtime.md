# Native Codex runtime for Siclaw

Status: native extension discovery and implementation in progress. This
direction supersedes wrapping Siclaw's Pi tool definitions in an MCP bridge.

## Requirements

- Preserve the existing SiCore-facing Runtime/AgentBox API, business policy,
  resource grants, persistence, and event contracts wherever possible.
- Reimplement capabilities supported by Pi within the Codex framework. Native
  Codex tools, instructions, model loop, compaction, planning, and multi-agent
  lifecycle are the execution owners. Pi remains a separately selectable
  engine; silently using Pi is not evidence of Codex compatibility.
- Keep the official Codex source and native model/tool behavior intact wherever
  upstream extension points suffice. Keep unavoidable patches small and reviewed
  on the protected GitLab source branch.
- Preserve whitelist-only execution, credential brokering, OS user isolation,
  path authorization, output sanitization, and cancellation guarantees.
- Validate SiCore as the UI first. Defer Portal UI work until runtime acceptance.

## Extension boundaries verified in the pinned source

The source pin is `aiops/codex` main at
`d4684bba63aba4c941d5a251054609e722b64779`.

| Boundary | Native ownership | Siclaw responsibility |
| --- | --- | --- |
| app-server thread/turn RPC | Model loop, stream, resume, steer, interrupt and fork | Session binding, persistence and SiCore event projection |
| `environment/add` and selected thread environments | Connect native execution environments | Register only authorized, session-scoped environments |
| Native `exec-server` protocol | Process launch, reads/writes, signals, termination, filesystem and PTY operations | Enforce command/resource/path grants and sanitize data before returning it to Codex |
| Native shell, `apply_patch`, image reading | Model-facing tool schemas and orchestration | Authoritative execution policy at the executor boundary |
| Native MCP and dynamic tools | Tool discovery, invocation and native orchestration | Product-specific services and external server authorization |
| Native hooks | Lifecycle integration and supplementary policy feedback | Investigation checkpoints, memory work and audit integration |
| Native multi-agent | Child creation, coordination, context and termination | Role/tier grants, resource inheritance, reports and existing SiCore task events |

`codex exec-server` ships as a subcommand of the source-built CLI. No npm Codex
wrapper is needed. `environment/add` and thread environment selection are
experimental upstream APIs, so the source pin and protocol integration checks
are upgrade gates.

The Linux image also needs bubblewrap for upstream sandbox execution and the
source-built `codex-code-mode-host` for catalogs selecting Code Mode. Copying
only the CLI binary is insufficient for the native tool path. Installing these
runtime prerequisites does not justify changing the container's security
context; execute the native probe under the intended restrictions.
The Code Mode build follows upstream's V8 setup action: use its sandbox-enabled
archive/binding pair and verify the release manifest against the digest in the
pinned source checkout. Do not substitute a different V8 build or disable its
sandbox to make Cargo succeed.

`scripts/test/codex-native-exec-probe.mjs` exercises official app-server +
exec-server with a fixed fake Responses model and a temporary workspace. It
checks actual native command output and native `apply_patch` file creation, with
no Pi session or Siclaw MCP tools. This is an architecture probe; it does not
enable production native execution or establish Siclaw security parity.

## Implementation direction

The first request-policy component is implemented in
`src/core/brains/codex-executor-policy.ts`, independently of Pi tool/session
types. It validates command form and whitelist, strips caller environment
overrides, scopes process continuation, and enforces read/write roots and link
denials. `codex-executor-output.ts` buffers and sanitizes complete outputs before
returning them. `codex-executor-relay.ts` pairs these policies with the official
exec-server protocol. The source-built native probe passes through this relay
with `SICLAW_CODEX_RELAY_PROBE=1` after `npm run build`.

The selected Codex brain now uses these components directly, without a Pi
AgentSession or ToolDefinition bridge. It preserves upstream base instructions,
supplies Siclaw business policy as developer instructions, and registers
session-scoped native environments. Cluster environments refresh broker
credentials at each process launch, including native children. Native file
commands use a literal read-only argv grammar and authorized paths. Native
process stop/connection close invoke the existing sandbox session reaper.

Interactive stdin/PTY, reconnect and file streaming remain disabled and fail
closed. Output is sanitized as a complete document; it is not streamed before
process completion. Long-running/background task parity still requires work.

1. Replace the generic Pi tool bridge with an execution policy adapter at the
   native executor boundary. Delegate process and filesystem mechanics to the
   upstream exec-server. Validate every permitted RPC before execution; unknown
   methods and unavailable policy must fail closed. Scope process/file handles
   to the session, validate actual paths, sanitize the child environment, and
   sanitize output before either model responses or UI events see it.
2. Keep the upstream base instructions. Supply Siclaw business instructions as
   application/developer instructions instead of replacing the native base
   prompt with Pi's assembled system prompt. Preserve the model catalog's native
   tool presentation, including Responses Lite and Code Mode where supported.
3. Reimplement cluster/node/pod/host bindings as authorized native environments
   and product services. Implement memory, reports, scheduling and other product
   capabilities through Codex-native extension contracts, independently of Pi
   ToolDefinition/ExtensionRunner APIs.
4. Use native Codex child-agent creation, waiting, coordination and lifecycle.
   Preserve executor grants in children and project native lifecycle events to
   SiCore. Do not reproduce Pi's spawn_subagent/map-reduce tool contract.
5. Responses is the only model protocol in scope. Cross-Agent handoff is deferred
   and not exposed. Explicit Codex selection must fail for unsupported bindings,
   rather than silently choosing Pi. Validate native clarification, attachments
   and structured-result contracts before claiming full compatibility.

## Security findings that constrain the adapter

Native `PreToolUse` hooks can reject or rewrite input. Some hook failures,
invalid outputs, and unsupported post-tool output rewrites are deliberately
nonblocking in upstream. Hooks alone cannot be the whitelist authority.

Read-only sandboxing does not establish Siclaw's credential secrecy, authorized
read roots, kubectl resource policy, or output redaction. Keep those controls
authoritative at the selected executor/service boundary. Native process
continuation and filesystem operations must go through that same boundary.

The native source includes model-specific tool configuration. Unknown model
fallbacks do not necessarily expose `apply_patch`; newer model catalogs can move
schemas into Responses Lite `additional_tools` and expose Code Mode/multi-agent
namespaces. Tests must exercise the intended provider/model configuration,
including any required source-built runtime helpers.

## Acceptance environment and gates

- Build on the Shanghai development host using
  `/Users/lrli/.local/bin/jump-ssh shanghai -- 'remote command'` in an independent
  directory.
- Use local kubectl for the user-designated `roce-test` cluster. The verified
  context is `kubernetes-admin@cz0er7pvw94gmuiq`; this task's namespace is
  `sicore-test`.
- Typecheck/build and Siclaw regression tests are necessary, followed by actual
  source-built native executor security tests.
- Deploy the reviewed native path in the test namespace and validate SiCore
  streaming, tools, plan, Stop, steer, restart/resume, model routing, attachments,
  memory, reports, jobs, native subtasks and scheduling. Handoff is deferred.
- Test denial paths independently: unauthorized commands/resources/files,
  leaked environment variables, raw output secrets, cross-session handles,
  policy failure, executor failure and canceled process groups.
- Compare the model-facing native tools and instructions with upstream; a
  successful Pi-backed fallback does not count as native Codex acceptance.

No test account secrets belong in source, image layers or recorded evidence.

## Current verification evidence

- Development build directory: `/tmp/siclaw-codex-validation.qRPCgN` on Shanghai.
- Source-built image `siclaw-agentbox:codex-native-5b414588`:
  `sha256:0bd065787b6c0d6cc6a481f0ee9ac6e24c27d1b297a4aadb24e9429a72aba4dd`.
  It contains the pinned Codex CLI, matching Code Mode host, and bubblewrap.
- The standalone upstream workspace sandbox cannot create its user namespace
  under the default Docker restrictions. Preserve those restrictions.
- The fixed native probe passes under the normal AgentBox entrypoint and
  default Docker permissions with `SICLAW_CODEX_RELAY_PROBE=1` and
  `SICLAW_CODEX_EXTERNAL_SANDBOX_PROBE=1`. It uses the upstream
  `thread/settings/update` `externalSandbox` contract. Siclaw's immutable
  request grants, sandbox UID transition, and output policy remain enforced at
  the relay. Native `exec_command` and `apply_patch` complete without Pi tools.
- Native session-factory source smoke: 15 fake Responses model calls, one native
  child that executes a command through the inherited policy relay, plan events,
  kubectl client output, apply_patch, file read/redaction, rejected command/path,
  transcript resume, early/active Stop and continuation. Custom provider headers
  reach the native Responses request. No Pi AgentSession or Pi tools are used.
- Current regression/typecheck/build evidence is recorded in the task; rerun
  after changes before advancing the tested image.

## Remaining acceptance work

- Source-built Linux Code Mode/Responses Lite and cross-UID cancellation tests.
- Test-namespace Runtime/AgentBox and SiCore streaming/tool/plan/subtask UI.
- Native product services: knowledge labels/citations, memory query/checkpoints,
  reports, schedules, host/node/pod diagnostic bindings and script execution.
  The removed Pi tools are not claimed as implementations of these services.
- Clarification, file attachments and structured-result contracts; external MCP
  output/artifact policy; child detail persistence and resource/tier policy.
- Interactive/background execution, stateful streaming and executor reconnect.

Full Pi replacement and complete end-to-end acceptance are not yet established.
