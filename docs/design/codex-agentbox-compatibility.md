# Codex AgentBox compatibility

Status: transitional prototype. The user selected a native Codex runtime on
2026-10-03; the target is documented in `codex-native-runtime.md`. The tool
bridge below describes the existing prototype and is not the intended final
architecture. SiCore is the first UI acceptance target; Portal UI is deferred.

Siclaw selects Pi or the source-built official Codex CLI inside the same
AgentBox. This integration preserves the existing Runtime API and session event
stream. It is not yet a complete replacement of Pi.

## Capability ownership

| Capability | Current implementation | Reason or remaining work |
| --- | --- | --- |
| Model loop, streaming, thread persistence, resume | Native Codex app-server | Siclaw translates notifications into its existing events and keeps a compatible transcript. |
| Turn steering, interruption, rollback | Native Codex RPCs | Adapter uses `turn/steer`, `turn/interrupt`, and `thread/fork`. |
| Context compaction | Native Codex | Siclaw does not impose Pi's compaction loop on Codex. |
| Execution checklist | Native `update_plan` | Siclaw projects plan notifications into the existing ledger and UI; Pi's task tools are hidden when native planning is enabled. |
| Skills | Native Codex loading with Siclaw-selected roots | Each session gets a private Codex home containing links to its authorized skills. Ambient project instructions are disabled; Siclaw supplies the compiled business prompt. |
| MCP protocol | Native Codex client, Siclaw MCP bridge | The bridge exposes the session's filtered tools and preserves argument validation, extension guards, output sanitization, and result artifacts. |
| Shell and background commands | Existing Siclaw tools through MCP | Native shell is disabled. Commands need Siclaw's whitelist, credential brokering, sandbox user, timeout/cancellation, and job lifecycle. |
| Read, search, write, edit | Existing Siclaw tools through MCP | Preserve authorized directories, sensitive-path denial, citations, and tool-result artifact access. Native `apply_patch` is disabled with native shell by the minimal source patch. |
| Cluster, node, pod, host and skill-script operations | Existing Siclaw domain tools through MCP | Codex does not supply equivalent resource binding or remote execution contracts. |
| Memory, knowledge, reporting and schedules | Existing Siclaw domain tools through MCP | These use Siclaw persistence and Runtime APIs. |
| Human clarification | Existing `request_input` through MCP | Siclaw ends the machine-driven turn and resumes on the next answer. Native user input needs request/answer lifecycle adaptation before it can preserve this contract. |
| Image input | Native Responses image input | Native `view_image` is disabled because arbitrary local paths need Siclaw's file authorization. File attachments continue on Pi. |
| Subtasks | Existing Siclaw orchestration with Pi child brains | Native Codex multi-agent tools are disabled. Child permissions, model tiers, persisted reports, map/reduce, mailbox delivery, and cancellation need a compatible adapter. |
| Cross-Agent handoff | Pi | A whole model tool-call batch must be validated before any handoff executes; individual MCP calls do not provide that boundary. |

Direct external MCP configuration, native shell/file tools, native user input,
and native multi-agent tools are further reuse opportunities. Enabling them
alone would bypass or change the contracts listed above. Evaluate these through
adapter work first, keep upstream source changes small, and preserve the
frontend/SiCore contract.

## Engine selection and remaining limits

`SICLAW_AGENT_ENGINE=codex` opts compatible new sessions into Codex. The current
compatibility check requires a Responses provider with the existing bearer-token
authentication contract and no custom headers, sampling overrides, or Pi model
compatibility overrides. Routing candidates must all satisfy that check.

Existing Pi transcripts, file attachments, required-result-tool requests,
incompatible provider bindings, and sessions exposing `transfer_to_agent` remain
on Pi. Children also remain on Pi. The setting therefore enables a mixed-engine
AgentBox; it does not demonstrate that all traffic uses Codex.

The implementation lives in `src/core/brains/codex-*`, engine selection in
`src/agentbox/http-server.ts`, and authorized tool assembly in
`src/core/agent-factory.ts`. Official source management and upgrade gates are in
the root `AGENTS.md` and `CLAUDE.md`.

## Verification

1. Run Siclaw typecheck, build, and the full regression suite on Linux.
2. Build `Dockerfile.agentbox` with BuildKit SSH forwarding. This compiles the
   pinned internal GitLab Codex source and runs the image capability checks.
3. Run `scripts/test/codex-app-server-smoke.mjs` with `SICLAW_CODEX_BIN` pointing
   to that source-built binary. Its fake Responses provider exercises native
   planning, MCP execution, transcript resume, early and active Stop, and
   continuation after interruption. It also checks that
   native execution tools are absent from the model's tool list.
4. Run the same script inside the AgentBox image with
   `SICLAW_CODEX_CONTAINER_SMOKE=1`. Use the normal entrypoint so it runs as
   `agentbox` with `NODE_ENV=production`. It additionally checks a rejected
   command never writes a file, credential-path denial, sandbox-user inability
   to read a synthetic credential, and an authorized kubectl client pipeline.
   Mount only the smoke script read-only at `/app/scripts/test`; the binary and
   production modules must come from the image.
5. Before rollout, validate real provider requests and an isolated Runtime +
   AgentBox deployment with SiCore as the UI: events, stop/restart/resume, model fallback,
   domain tools, background jobs, subtasks, and the Pi fallback cases above.

The fake provider and standalone container checks do not establish real-model
quality or production Kubernetes acceptance.
