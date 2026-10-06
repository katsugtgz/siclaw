# Native Codex product contracts

## Scope

Codex owns the model loop, tool discovery, Plan, children, execution processes,
conversation history and memory. Siclaw supplies product services and security
at those native boundaries. Official Codex remains pinned to GitLab main
`d4684bba63aba4c941d5a251054609e722b64779`; this work needs no Rust patch.

## Shared business services

`manageSchedule` is the same engine-independent service for Pi and Codex. It
uses `GatewayClient`; Runtime owns task identity, authorization and persistence.
Native MCP exposes only enabled `manage_schedule` and `task_report` operations
under reserved `siclaw_workflow`. Mutation admission requires the current owned
root turn and native call ID, never a model-supplied session or owner identifier.
One native call cannot dispatch a mutation twice. External MCP keeps its existing
operator-owned read-only policy; product scheduling grants no infrastructure
write permission. Existing tool names/results preserve schedule cards and cron
report collection.

The current investigation contract is a mode flag and Markdown checkpoints,
not the removed hypothesis/state-machine tools. Native input transformation
reuses current guidance and UI hints, persists/restores the shared `dp-mode`
entry, and delegates parallel work to native children. Sustained tool use sends
a checkpoint instruction through native steering. Native Plan remains native.
Checkpoint rollback restores the mode and the current transcript branch.

## User questions

`item/tool/requestUserInput` is the only admitted server request. Questions are
matched to the active root turn, bounded, sanitized and rejected for secret
input. Existing chat/steer delivers answers to native RPC, including numbered
answers for multiple questions. Existing suggested-reply chips display options.
Stop/close/turn completion cancels pending questions. An opted-in external caller
receives the existing `input_required` event and answers on its next turn.
Native async message/question items retain native behavior and projection.
Question answers never authorize execution; approval and credential requests
remain rejected, and the whitelist remains authoritative.

## Attachments

Pi and Codex share attachment validation/text extraction. SiCore forwards UTF-8
TXT/LOG/Markdown/JSON/YAML/CSV/XML files over the existing files contract and
keeps image/PDF routing. Native Codex mounts only sanitized text under the exact
conversation input directory and reads it with native tools. Other conversation
inputs, writes, links and opaque binary data are denied. Raw PDF bytes are sent
only to the existing operator-configured `SICLAW_OCR_BACKEND_URL`; no parser or
OCR dependency is added to AgentBox. The shared OCR backend uses its existing
PDF library for text layers and retains OCR for scanned/mixed pages. Models
consume extracted text; Codex therefore does not require native PDF model input
capability. Missing OCR fails explicitly for raw PDF input. Caller-side OCR
continues to work as before.

## Connections and models

The official authenticated exec-server WebSocket daemon owns native session
IDs, processes, sequence numbers and output retention. The adapter retains only
an owned authorization context while the native session is detached (30 seconds).
A second attachment, foreign session and unowned process are rejected. Native
reconnect/replay is reused; there is no Siclaw process-output/job ledger.
Bounded native concurrent RPC dispatch permits Stop while a read is pending.
The adapter forces native environment readiness before exposing its tools.

Provider URL, headers, token and auth-mode changes restart the private app-server
on the next turn and resume the same native conversation. Owner-scoped old token
literals remain in memory for safe in-flight error sanitization. Native error
messages are sanitized before UI/persistence. Responses remains the only model
protocol; explicit header-only/no-auth configuration is supported. Native model
context and reasoning configuration remain native.

## Verification

- Component, full TypeScript/Vitest and build checks are required.
- Source-built product smoke covers attachment reads, native question answers,
  every schedule action, reports, mode restoration, token/model changes, safe
  authentication failures and cold resume.
- Source-built reconnect smoke covers the same process/session, sequence replay,
  no duplicate output, cross-session rejection and cancellation.
- Linux and scoped SiCore live evidence are recorded after deployment acceptance.

Large structured-output incremental redaction, memory isolation, Portal UI and
cross-Agent handoff remain explicitly deferred. Siclaw memory integration is
outside this migration.
