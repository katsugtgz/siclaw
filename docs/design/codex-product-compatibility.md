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
answers for multiple questions. Text-only surfaces preserve their existing
question rendering. Codex console/self-service WebChat exposes a structured
Question card directly above the composer, without a modal overlay or duplicate
suggested-reply chips. It supports selected/custom answers, multi-question
navigation, explicit Send, close/reopen and Skip
through owner-scoped pending-input and answer RPCs. Each request has an adapter
UUID; answers match the current request/question IDs, persist before native
resolution and never fall back to starting a new prompt. Pi, shared Analysis,
embed and Feishu retain their existing text-answer contracts. Refresh restores
only a live pending request; stopped/expired requests are refused.
Skip resolves the exact request with empty native answers without selecting an
option or stopping the turn. Closing the card only hides it; Stop, executor
close and turn completion cancel pending questions. No countdown is invented
without a native timeout contract. An opted-in external caller
receives the existing `input_required` event and answers on its next turn.
Native async message/question items retain native behavior and projection.
Question answers never authorize execution; approval and credential requests
remain rejected, and the whitelist remains authoritative.

## Attachments

Codex user images use native app-server `turn/start`/`turn/steer` image inputs.
Runtime advertises `agentEngine=codex` and `nativeImageInput=true` through the
existing `chat.capabilities` RPC. SiCore reuses its existing images transport,
not OCR, for upload/steer and authorized first-party URL inputs. Pi's routing
and PDF extraction remain separate. Public framework user echoes contain text
only; original images remain in the private native conversation. This does not
enable arbitrary filesystem image reads or opaque external MCP image results.
The legacy Pi media-candidate filter must not reject Codex input before the
native app-server/model validates its own modalities. The image-input
source-built smoke exercises that framework routing layer, actual Responses
image parts and the absence of image bytes in public events/shared history.
Real visual acceptance is separate from that deterministic protocol check:
the 2026-10-07 browser run correctly reads the unique heading and all three
colored shapes without a tool call; the independent API's OCR attempt counter
remains zero. This does not certify every catalog model's vision capability.

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

### Native children and synchronous IM requests

Native `wait_agent` remains the normal orchestration path. Its V1 result may
cover only the first terminal target; V2 wakes on mailbox updates or timeout.
Neither tool is a mandatory all-children completion switch. Siclaw therefore
uses an execution-only fence around the accepted logical request. The fence
spans provider attempts and native parent turns; it stores no second child
transcript or Pi job. Native spawn/turn/terminal events establish frozen request
ownership, including descendants and reused child execution rounds.

If the parent reports after all owned child executions end, no extra model turn
is added. An early parent return keeps the same sync request/SSE consumer open.
After native children end, the same native parent thread receives a bounded
continuation instruction and produces the final report using its native result
context. A draft started before the last child finishes is not retroactively
accepted as the final report. Native connection loss fails the fence; Stop
interrupts owned native execution turns and latches late starts. Old-request
completion cannot finish or steer a new request. Async results retain an
owner-captured, coalesced late-result recovery path. Final task reports and
`channel_update(kind=final)` are denied while owned children remain running.

Feishu and scheduled tasks request sync admission. Feishu updates one card with
native child counts and a synthesis phase; only the logical terminal finalizes
it. Explicit progress delivery uses the existing persisted input/message ID,
forwarded through Runtime and AgentBox. Registrations are isolated by session
AND request ID; unscoped/stale updates cannot hit a newer request's card, and an
older cleanup cannot remove a newer registration. No SiCore schema, additional
controller, provider credential or native Rust change is required.

Local regressions and pinned source-built deterministic protocol tests are not
real Feishu acceptance. Deployment and a human-triggered slow-child/channel
case must be recorded separately before claiming the channel path accepted.

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

### Native fleet and product services

Capability-selected `cluster_list` and `host_list` now use the same business
services as Pi through the intrinsic `siclaw_workflow` MCP endpoint. They do not
require `exec_command`. Cluster discovery keeps name filtering, administrator
metadata and kube-contexts; native calls refresh current bindings. Host discovery
keeps server-side name/IP/description search, bounded pages, `total` and
`next_cursor`. Neither default lookup acquires credentials or contacts a target.
`probe=true` requires the API command capability independently of metadata access.

Native `skill_preview` preserves the existing UI `skillPreview` metadata and
package limits. Its drafts root is session-scoped inside the authorized workspace.
Only that draft is collected and removed; links and out-of-scope directories are
rejected. Preview does not publish, approve, load or execute generated scripts.
Native application instructions identify this root without editing `prompt.ts`.

`save_feedback` records a structured product report in the framework session's
custom entries and the ordinary tool-history result. Actor/session attribution is
host-supplied. It is separate from human thumbs-up/down records and native memory.
The legacy empty feedback HTTP ACK is not a valid storage receipt. No new table,
memory index, production dependency or additional resource store is introduced.

`channel_update` calls the existing session-bound channel executor. Gateway retains
recipient selection, coalescing and delivery policy. Feedback, draft cleanup,
channel delivery and schedule management require an active root turn; attributed
native children may read inventory only. Native call identity, arguments, single
use and cancellation are validated before dispatch and before returning results.

Examples in native JavaScript (exact callable names follow the pinned catalog):

```js
text(await tools.mcp__siclaw_workflow__cluster_list({ name: "prod" }));
text(await tools.mcp__siclaw_workflow__host_list({ query: "gpu", limit: 20 }));
text(await tools.mcp__siclaw_workflow__host_list({ cursor: previous.next_cursor, limit: 20 }));
```

The last pagination example assumes `previous` is a successfully parsed first-page
result in the same cell or explicitly stored across cells. Code Mode globals do
not carry ordinary JavaScript variables into the next cell.

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
