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

## Accepted on 2026-10-07

Runtime implementation is `acc1e7aa`, with shared GatewayClient identity fix
`4d26a3dc`. SiCore text forwarding is `179403941`; task list fix `0925398e7`
returns both active and paused tasks for the same agent/creator, excludes deleted
rows, and leaves `task.listActive` active-only. Listing must preserve the trusted
`session_id` as well as include paused tasks; fixing only one side is insufficient.
Additional source-built smoke `7e766adc` passes on macOS and in the final Linux
AgentBox image: a second model URL receives the request, header-only auth sends
no Bearer header, removing auth clears old headers, and every schedule query
preserves the trusted session. No runtime source change is needed for these
additional checks.

| Contract | Evidence |
| --- | --- |
| UTF-8 attachments, questions and investigation mode | Actual `gpt-5.6-luna` reads the uploaded log, requests native user input, receives the SiCore steer answer and performs read-only Pod checks. The fixture token is absent from SSE. Deep Investigation, question/answer and final result remain visible after UI reload. |
| PDF attachment | Actual upload of a PDF with a known text-layer fixture returns `CODEX_NATIVE_PDF_ACCEPTED` with the extracted Pod-status evidence through the existing OCR service. No AgentBox PDF dependency or native PDF model capability is required. |
| Native schedule management | Custom preview conversation `63cb5a96-5d34-40af-be13-922ef69fa56b` creates exactly one paused task, lists it, renames it, changes cron and pauses it. Actual API/MySQL reads confirm name, cron, paused state and creator. Native result rows keep the real task name instead of falling back to its UUID. |
| Cold restore and delete | The dedicated Custom AgentBox Pod is recreated (UID `9f1f627c-7c70-493f-aa82-99a0bcbe3d91` to `bbfb33c2-0f0a-47c8-9584-323f21e901fd`). The same public conversation lists and natively deletes only its own temporary task; its API then returns 404. |
| Reports | A manually fired paused test task performs a real read-only Pod query, calls native `task_report`, and persists a successful run with the report marker in `result_text` and the corresponding tool row. Run ID: `23d8b3a5-2e34-449c-a1dc-f5db035ec486`. |
| Execution reconnect | Source-built Linux exec-server checks pass same-session/process reconnect, sequence replay without repeats, process-tree cancellation, foreign-session rejection and UID 1001 isolation. |
| Provider failures and changes | Source-built deterministic Responses tests pass token rotation, model selection, URL/header binding restart, safe 401, failure recovery and cold resume. These are controlled protocol checks, not live rotation of a shared production provider. |

The actual log/PDF/schedule runs select configured Responses model
`gpt-5.6-luna` with `isFallback=false`. Earlier named Code Mode/V2 runs remain
in the runtime design; this acceptance does not certify every catalog model.

The final Siclaw source passes **423 files / 8772 tests**, `tsc --noEmit` and
`npm run build`. SiCore adapter/proxy packages pass. The added database-backed
RPC regression first fails on the active-only list and then passes for paused
visibility, other-user/agent exclusion, soft deletion and scheduler eligibility;
the same regression also passes in the Linux Go builder.

Eight source-built Linux smoke suites cover products, knowledge, MCP security,
streaming, executor policy, reconnect, native factory and Skill scripts. They
use deterministic model fixtures where a model is needed. The real SiCore
runs above are separate evidence. OCR regression also passes its 16 tests.

The independent validation environment in `roce-test` / `sicore-test` uses:

- AgentBox digest `sha256:8938c627162264e7dd77d09865bd8e5fdaf7b53731c97bd6f6c007922a8a8f19`.
- API digest `sha256:b1ced0c1a416aa57b80c0ed029e26b5b4c960b139a70c15a676a5ed1d754cbd8`.
- Runtime digest `sha256:43bbe448e0a0d5099a76071537ba5490aefa4ff9684f3003501216e5acc12d40`.
- OCR digest `sha256:b098db4fbe7c0fa880affc4dae5a98710aecf5802ccdb510b475463ce0777bda`.

The API test image uses private database-compatible baseline `741a7d838`, plus
the text-attachment and task-list patches, and skips database migrations.
This is deliberately separate from the normal SiCore API/Web deployment and
does not migrate or replace its database. The local Next.js validation UI uses
the branch frontend with this independent API. Temporary paused acceptance
tasks are soft-deleted after their evidence is captured; histories remain.

Earlier failed business runs are not counted as acceptance: the SRE capability
set does not grant scheduling, one test token expired, and an active-only list
hid the paused tasks. The corrected tests validate actual results and database
state rather than a marker appearing in a denial explanation.

Large structured-output incremental redaction, memory isolation, Portal UI and
cross-Agent handoff remain explicitly deferred. Siclaw memory integration is
outside this migration.
