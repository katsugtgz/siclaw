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
- Codex uses its own native memories, conversation history, resume and
  compaction. Do not implement compatibility with Siclaw's memory mechanism.
  SICLAW_MEMORY_ENABLED, the legacy indexer/profile/flush hooks and session
  auto-save apply only to Pi. Native Codex memory is enabled through upstream
  configuration and uses the upstream storage format and dedicated tools.
  New conversations share a private native home only within the same Agent,
  user and selected Skill set. Anonymous contexts remain conversation-scoped.
  Existing Codex conversations retain their original native home so that
  SQLite history is not copied or lost. Native notes/search/generation are
  owned by Codex; no Siclaw memory file or index is imported.

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
| Native memories | Generation, consolidation, prompts, notes and retrieval | Private persistent storage for the authorized owner and Skill scope |
| Native hooks | Lifecycle integration and supplementary policy feedback | Enabled investigation workflow and audit integration |
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
   and product services. Implement reports, scheduling and other enabled product
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
  reports, jobs, native subtasks, scheduling and native memory persistence/
  isolation. Cross-Agent handoff is outside the current acceptance scope.
- Test denial paths independently: unauthorized commands/resources/files,
  leaked environment variables, raw output secrets, cross-session handles,
  policy failure, executor failure and canceled process groups.
- Compare the model-facing native tools and instructions with upstream; a
  successful Pi-backed fallback does not count as native Codex acceptance.

No test account secrets belong in source, image layers or recorded evidence.

## Current verification evidence (2026-10-05)

### Native memory update (2026-10-06)

- Runtime source commit `d74db318`; typecheck/build and **407 files / 8047 tests**
  pass. No additional upstream Codex source patch was needed.
- Linux test image
  `registry-cn-shanghai.siflow.cn/k8s/siclaw-agentbox:codex-memory-d74db318`,
  digest `sha256:5a4bb343f4bbbb0b92e39ef2d930118d4cc82ad86358c81f514a235f81970821`.
- The real factory uses official `memories` tools for notes and reads, even
  with `SICLAW_MEMORY_ENABLED=true`; no legacy indexer, profile prompt or
  auto-save is initialized for Codex.
- Source-built native checks pass for write/read, a second conversation's
  memory retrieval, another owner's denial, old native-home history resume
  and the existing plan/command/child/Stop/resume workflow.
- Fake Responses fixtures distinguish native memory-consolidation sessions
  from user turns. The upstream generation pipeline and prompts are retained;
  summary quality still needs real-provider acceptance.
- Container memory, full native conversation and Code Mode/V2 child checks pass.
  `siclaw-native-memory-20261006` completed in `roce-test/sicore-test` under the
  normal AgentBox filesystem/capability/seccomp restrictions. Its resources
  were removed after saving logs.

- Runtime source at `755cfd84`; subsequent commits update validation scripts.
  Codex source remains pinned to GitLab main `d4684bba63aba4c941d5a251054609e722b64779`.
- Typecheck and build pass. Full regression: **406 files / 8045 tests**.
- Source-built AgentBox test image:
  `registry-cn-shanghai.siflow.cn/k8s/siclaw-agentbox:codex-native-755cfd84`,
  registry digest `sha256:17f8c8335e754dfeb58b3cb1ade78332f405eea7bf3fa5218c291dc1e29b5ab1`.
  It contains the official CLI, matching source-built Code Mode host and upstream
  sandbox-enabled V8, plus bubblewrap.
- The upstream workspace sandbox cannot create a user namespace under default
  Docker restrictions. Siclaw uses the native `externalSandbox` contract and
  enforces grants, OS identity and sanitization at its executor boundary.
- `codex-native-brain-smoke.mjs`: 16 fake Responses calls, native V1 child command
  execution and denial, plan events, kubectl output, apply_patch, file read and
  redaction, command/path rejection, old Pi tool-evidence restoration, native
  resume, early/active Stop and continuation. No Pi AgentSession or tools run.
- `codex-code-mode-smoke.mjs`: native gpt-6.1-sol catalog, Responses Lite,
  `functions.exec`, source-built Code Mode host and authorized native command
  execution pass. Native V2 spawn, child command execution, send_message and
  mailbox/wait delivery also pass in the namespace. V2 controls are direct `collaboration` tools by upstream default, and
  model-originated messages use opaque `agent_message.encrypted_content`.
- `codex-executor-smoke.mjs`: UID 1001, complete process-tree cancellation,
  cross-session handle denial, stdin rejection, complete-document Secret
  redaction and broker failure rejection pass.
- All three isolated namespace Jobs completed successfully using the final image:
  `siclaw-native-brain-20261005`, `siclaw-native-executor-20261005` and
  `siclaw-native-v2-20261005` in
  `roce-test` / `sicore-test`. Their spec matches the normal AgentBox's read-only
  root filesystem, RuntimeDefault seccomp and existing capability set. Test
  resources were cleaned up after saving their logs.
- Local source-built native parent and child both select `cluster:roce-test`
  and perform a real read-only `sicore-test` Pod query. The fixture broker
  refreshes the credential binding once per launch. This verifies execution
  environment selection; it does not verify SiCore-issued credential RPCs.
- Runtime test image is built and published at
  `registry-cn-shanghai.siflow.cn/k8s/siclaw-runtime:codex-native-074538b9`.
  A Runtime has not been registered/deployed for SiCore UI acceptance yet.

The model is a deterministic fake Responses server in these checks. Real model
quality, production provider protocol compatibility and SiCore UI acceptance are
not established by the component/namespace results.

## Remaining acceptance work

- Real provider acceptance must include the catalog's native Responses Lite
  and opaque agent-message contract when applicable; fake Responses checks
  do not establish those provider capabilities.
- Test-namespace Runtime/AgentBox with SiCore: streaming/reasoning, tool/plan and
  child views, Stop/steer, restart/resume, model routing and usage accounting.
  The login page requires an account email; the test password was provided in
  the task but the email is still pending. No Portal UI acceptance is attempted.
- Native product services: knowledge labels/citations, enabled investigation
  workflow state, reports, schedules, host/node/pod
  diagnostic bindings and script execution. The removed Pi tools are not claimed
  as implementations of these services.
- Siclaw memory search, generation and publication are not migration targets.
  Native Codex memory needs its own source-built read/write, restart and owner
  isolation checks; retaining old Pi memory code does not establish support.
- Native clarification, file attachments and structured-result contracts;
  external MCP output/artifact policy; child detail persistence and resource/model
  policy. Explicit unsupported requests must never silently run Pi.
- Interactive/background execution, stateful streaming, bounded finished-process
  output retention and executor reconnect.

Full Pi replacement and complete end-to-end acceptance are not yet established.

## Deferred follow-ups

- **Native Codex memory isolation:** recorded at the user's request on
  2026-10-06. Further isolation design, review and implementation are deferred
  until the user resumes this topic. Existing memory behavior is unchanged.
