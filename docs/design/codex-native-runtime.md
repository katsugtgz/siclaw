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
denials. It is not wired into the production brain. Output policy, the relay,
native interactive execution, file streaming, and full lifecycle integration
are required before enabling it; currently unsupported RPCs fail closed.

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
4. Use Codex-native multi-agent and user-input contracts, translating their
   lifecycle into existing SiCore events. Keep Codex children on Codex and retain
   current business grants, tier selection, map/reduce, resume and cancellation.
5. Test provider compatibility, attachments, required result contracts and
   cross-Agent handoff explicitly. A Pi fallback must remain visible as a
   separate compatibility limitation until the Codex implementation passes.

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
  memory, reports, jobs, subtasks, scheduling and handoff.
- Test denial paths independently: unauthorized commands/resources/files,
  leaked environment variables, raw output secrets, cross-session handles,
  policy failure, executor failure and canceled process groups.
- Compare the model-facing native tools and instructions with upstream; a
  successful Pi-backed fallback does not count as native Codex acceptance.

No test account secrets belong in source, image layers or recorded evidence.
