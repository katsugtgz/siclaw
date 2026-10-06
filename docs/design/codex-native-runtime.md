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
- Native MCP runs through the protocol security gateway described in
  [Read-only MCP and pre-model output security](mcp-readonly-security.md).
  Pi and Codex share explicit operation admission and owner-scoped redaction;
  arbitrary opaque outputs and filesystem image viewing are unavailable.
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
denials. `codex-output-stream.ts` sanitizes bounded security records before
bytes reach the official exec-server. `codex-executor-relay.ts` forwards native
process output, sequence, reads and lifecycle without a second retention ledger. The source-built native probe passes through this relay
with `SICLAW_CODEX_RELAY_PROBE=1` after `npm run build`.

The selected Codex brain now uses these components directly, without a Pi
AgentSession or ToolDefinition bridge. It preserves upstream base instructions,
supplies Siclaw business policy as developer instructions, and registers
session-scoped native environments. Cluster environments refresh broker
credentials at each process launch, including native children. Native file
commands use a literal read-only argv grammar and authorized paths. Native
process stop/connection close invoke the existing sandbox session reaper.

Interactive stdin/PTY, reconnect and file streaming remain disabled and fail
closed. Native long processes, continuation and output budgets remain owned by
Codex. Safe complete text records flow while a process runs; structural data
waits for its security boundary. See
[codex-readonly-infrastructure.md](codex-readonly-infrastructure.md#native-long-processes-and-output).

The pinned native `thread/resume` protocol does not accept `environments`.
Every `turn/start` must select the authorized environments again. Siclaw also
sets `include_local = false` and `default = "none"` in the native environment
registry, so an omitted selection or internal worker cannot fall back to an
unmanaged local executor. A conflicting existing registry fails closed rather
than being overwritten. Native background memory consolidation that needs file
execution still requires an authorized environment; notes/read tools continue
to use Codex's own memory implementation.

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

## Current verification evidence

### K8sSpawner acceptance update (2026-10-06)

- The user explicitly approved the standard namespace Role/ServiceAccount and
  shared-PVC test deployment. The independent Runtime now uses K8sSpawner and
  persisted CA `siclaw-native-validation-ca`. ProcessSpawner is scaled to zero.
  SiCore's existing API/Web deployments are unchanged.
- AgentBox `agentbox-79068105-473b-4417-8935-b4f11c16c5b3-0` runs the source-built
  `codex-executor-b7c3642d` image with read-only rootfs, RuntimeDefault seccomp
  and the normal capability set. Its PVC mount is limited to the new test
  Agent's `agents/79068105-473b-4417-8935-b4f11c16c5b3` subpath.
- Actual mTLS settings, resource sync and persistence callbacks succeed. The
  Agent resolves as SRE with its locked capability set. A pending native Plan
  survives UI reload. Completed plans auto-clear after five seconds by the
  existing product behavior; persisted reset/upsert events confirm this is
  not missing history.
- SiCore's real credential API issues a short-lived test kubeconfig to the
  native cluster environment. `kubectl -n sicore-test get pods -o json` succeeds
  through the broker. The fixture ServiceAccount can only get/list/watch Pods
  in `sicore-test`; no administrator kubeconfig is copied. The required
  management-host record is actual node metadata, with no SSH credential or
  claim of SSH acceptance.
- Deleting/recreating only the test AgentBox changes its Pod UID and preserves
  native thread id, pending Plan snapshot and workspace file. Restarting only
  the test Runtime preserves the CA and existing AgentBox; resumed file reads
  and real broker queries succeed.
- The initial native V1 child reads/waits/closes, but that image does not persist
  a public child session or attribute child usage. These implementation gaps are
  closed by the later native child projection acceptance below. The existing
  `children?group_id=...` endpoint is batch discovery (`group#item` lineage),
  not an individual native child's discovery contract.
- Root usage did reach SiCore, but cold attachment was overcounted: the native
  root has 20 completed calls / 321881 tokens, versus 25 facts / 406000 tokens.
  Upstream explicitly replays the last usage snapshot with its historical
  turn id on attachment. Fix `fe33b2a8` counts only active-turn usage and seeds
  historical snapshots for deduplication. The regression fails before the fix;
  source-built smoke matches actual completed parent responses after it.
  Typecheck/build and **407 files / 8049 tests** pass. Live image acceptance
  for this second fix passes: three real Responses calls with two normal
  release/resume cycles produce exactly three SiCore facts / 29922 tokens,
  matching the native rollout's three calls / 29922 tokens.
- Fixed image `siclaw-agentbox:codex-usage-fe33b2a8` is deployed to the independent
  test Runtime, registry digest
  `sha256:9150f9e9bdf01e3183c00e8bff1c54fd2102ac341bade55115158c2e2579773a`.
  A cross-namespace query using the restricted fixture returns Kubernetes
  Forbidden; no alternate credential or execution environment is used.

One test dispatch failed before model execution with a test-cluster etcd timeout;
retry after confirming Pod health succeeded. This is recorded separately from
Codex/provider failures. The standard Runtime's startup orphan sweep removed an
old certificate Secret with no backing Pod; no existing running AgentBox was
replaced.

### Live Responses and SiCore update (2026-10-06)

- Independent Runtime registration and two private test Agents are used in
  `sicore-test`. The validation Pod uses ProcessSpawner with separate Runtime
  and AgentBox processes, private emptyDir volumes, no ServiceAccount token,
  and the normal AgentBox capability/seccomp restrictions. It does not establish
  K8sSpawner, mTLS callback or shared-PVC acceptance. Automatic approval rejected
  the standard shared-namespace RBAC/PVC deployment; explicit approval is pending.
- Real `api.scitix.ai/model-api` Responses calls through SiCore pass for
  `gpt-5.6-luna`: greeting, native apply_patch/read, live Plan projection,
  native V1 child creation/read/wait/close, and steer from the UI.
- A fresh conversation passes UI Stop and continuation. An earlier conversation
  returned provider `content_filter` after Stop; this remains an unresolved
  provider/history case, not a successful continuation result.
- Real `gpt-6-astra` passes Code Mode file creation/read and V2 text/file children
  explicitly created without inherited history. A child launched after parent
  tool history failed with `Encrypted function output content could not be
  decrypted or decoded` before the executor fix. Post-fix checks pass for a child
  inheriting full parent tool history and, after normal release/resume, a child
  reading the parent's file with full inherited history. The earlier provider
  error's cause is not established; it is not silently rewritten or downgraded.
  V2 uses its native lifecycle; a V1 close operation is not required of V2.
- Plan is visible while the turn runs, but disappears after reload in this
  ProcessSpawner setup. AgentBox reports rejected task-event persistence
  callbacks. Native V2 spawn/message events and child details also need complete
  SiCore projection and persistence.
- Live denied-root testing exposed an execution-policy bypass after session
  release/resume: `cat /etc/hostname` executed through the native local fallback.
  The test Pod was stopped. Fix `b7c3642d` disables unmanaged local environments
  and selects authorized environments on every turn; Codex source is unchanged.
- The official source-built regression fails before that fix and passes after
  it, checking resumed denied reads, sanitized allowed reads and rejection of
  explicit local execution. Typecheck/build pass; full regression is
  **407 files / 8048 tests**. Native notes/read and legacy-home resume smoke also
  pass.
- Fixed AgentBox image:
  `registry-cn-shanghai.siflow.cn/k8s/siclaw-agentbox:codex-executor-b7c3642d`.
  The independent `siclaw-native-policy-20261006` Job completes under the normal
  restrictions: restored executor authorization/redaction, native memories and
  source-built Code Mode checks pass. Logs are saved before resource cleanup.
- Post-fix SiCore UI passes allowed apply_patch/read, waits through the normal
  30-second brain release, then rejects `cat /etc/hostname` on the restored
  conversation with `Native filesystem path is outside the session grant`.
  The test-only ProcessSpawner image is
  `registry-cn-shanghai.siflow.cn/k8s/siclaw-native-validation:b7c3642d`, digest
  `sha256:131a97d4c5ea49d9c705644a490e7eabb7e9b9fc0a66132b806b2c859d373f19`.

Opaque Responses state remains owned by Codex. Preserve replayable output items
and program callers as specified by the
[official programmatic tool calling guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling).
Do not strip encrypted items or replace native delegation with Pi tools to make
the provider accept a test.

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

## Remaining acceptance work (reconciled 2026-10-07)

Use the dated acceptance sections and linked records for exact source/image
revisions. Read-only cluster/node/Pod/SSH execution, reviewed Skill scripts,
shared resource mounts/brokering, MCP admission/pre-model sanitization, native
Plan, native child projection/continuation/usage, long processes and native
output retention now have component, source-built and scoped live evidence.
They are no longer blanket migration TODOs. The latest long-process/security
evidence is in [Native read-only infrastructure](codex-readonly-infrastructure.md#native-process-and-streaming-acceptance-2026-10-07).

| Priority | Remaining contract | Current evidence and required result |
| --- | --- | --- |
| First | MCP failure reason in the SiCore tool card/history | `CodexAgentBrain.handleEvent` projects `item.result.content` but does not project native `item.error`; error-only items can persist an empty reason. Preserve the safe native reason through existing events and storage. |
| First | Knowledge answer citation display | Knowledge selection/mounts and native reads are shared. Pi's `noteRead`/`knowledge_cite` path exists, but Codex does not register that product service or observe those reads for the citation sink. Add a native integration for validated read provenance and the existing citation event/card contract. |
| Next | Enabled investigation state, reports and schedules | Codex skips Pi extension factories and does not register the corresponding product operations. Implement only enabled business contracts through native extension/service APIs, without exposing Pi ToolDefinitions. Native `update_plan` remains the plan owner. |
| Next | Native structured user questions | Natural-language questions in chat remain available. Native `experimental_request_user_input`/async user-message tools are disabled and unsolicited server requests are rejected. Connect authorized native question requests/answers to the existing SiCore input contract. Infrastructure approvals remain governed by the whitelist. |
| Next | Non-image attachments | User image input is supported; `PromptMedia.files` is explicitly rejected. Reuse the shared scoped attachment materialization and expose approved file reads through native execution, with private-path and output controls. |
| Acceptance | Target Responses provider/model combinations and failures | Named live runs establish their exact combinations, not every catalog entry. Exercise required Responses Lite/opaque history contracts, model/provider/key changes and failure recovery when those combinations are selected. Keep test-body fixtures separate from real provider evidence. |
| Lower | Native executor reconnect | Cold conversation restore works. `initialize.resumeSessionId` is rejected; a lost execution connection cancels its owned processes. Supporting reconnect requires owned handle/replay and resource authorization, not another job ledger. |

Interactive shell/PTY and arbitrary opaque image/file output remain deliberate
safety boundaries. Full raw log archival/search is optional product work; native
truncation/continuation already owns ordinary large-output behavior. Cross-Agent
handoff, Portal UI and memory isolation retain their separately deferred scopes.
Siclaw memory search, generation and publication remain outside this migration.

These remaining product contracts prevent a blanket claim of full Pi feature
replacement. Do not interpret successful executor tests as their implementation.

## Native child projection acceptance (2026-10-06)

Implementation `85337308` observes native V1 collaboration items and V2
`subAgentActivity`, including owned descendants. Upstream already attaches child
listeners; Siclaw does not resume a child to subscribe or run a Pi child session.
Native Codex still creates, coordinates, waits for and closes its children.

- A private journal maps native thread IDs to stable public child session UUIDs,
  retains pending persistence, and fences replayed items and usage. Unrelated
  internal threads cannot acquire ownership through an event alone.
- AgentBox uses the existing Runtime-owned `GatewayClient` persistence contract:
  create the owned child row before transcript/usage, redact persisted content,
  and emit existing terminal records. Committed appends with lost acknowledgements
  are reconciled against transcript projection keys before retry; this reuses
  the existing append API and does not add a database uniqueness guarantee.
- Child billing uses the native child model metadata and `internal_subagent`
  role, with deterministic call IDs and frozen parent dispatch identity.
  `b9087f4c` captures native continuation identity at tool start, before a fast
  child response can precede the parent's tool completion. Child work keeps its
  parent resident while running; no Pi mailbox wakeup controls native lifecycle.
- SiCore branch `feat/native-codex-child-ui` adds native launch-name tolerance in
  two UI modules. Existing child authorization, transcript readers and completion
  folding are reused. No backend/schema or production dependency changes.

The independent K8sSpawner Runtime now selects source-built AgentBox image
`siclaw-agentbox:codex-child-b9087f4c`, digest
`sha256:78412a96b5a002465a7892dab259b41fab76a9969833776961b429856964a692`.
Codex remains pinned to GitLab main `d4684bba63aba4c941d5a251054609e722b64779`.
Existing SiCore API/Web deployments are unchanged; an isolated local Next.js UI
uses the actual test API and MySQL.

| Real native check | Result |
| --- | --- |
| V1 safe workspace read and `/etc/hostname` rejection | Pass; child transcript includes success and denied tool rows |
| V2 safe workspace read and same path rejection | Pass; native V2 lifecycle, no invented close operation |
| V1 parent/child usage before cold restore | 6 calls / 74565 tokens; 3 calls / 30789 tokens |
| V1 cold restore and native resume/send/wait/close of the same child | Pass; unchanged public child ID, 10 persisted child rows |
| V1 usage after continuation | Parent 11 / 145709; child 5 / 51986, exact native rollout match |
| V2 cold restore and completed-child replay fence | Parent 6 / 77794; child remains 3 / 38067, exact native rollout match |
| Child dispatch attribution | V1 continuation belongs to the new parent trace; V2 inactive child keeps its original trace |
| Pending projection journal | Empty after both live runs and cold restores |

Source-built smoke checks one native child, three child model calls, transcript,
failure rows, terminal state, executor grants and parent resume/Stop. The final
Siclaw source passes **409 files / 8055 tests**, TypeScript and build. SiCore's
five focused files pass **208 tests** and TypeScript. Real Playwright checks
native V1 audit and V2 Preview cards, child reads and reload persistence; audit
trace placement is checked so asynchronous placement cannot hide a native card
inside a generic command batch. Native HTTP/LLM timing is not invented; missing
timing and separate child trace envelopes remain explicitly labelled by audit.

## Deferred follow-ups

- **Large structured output and incremental redaction:** recorded at the user's
  request on 2026-10-07; implement later, not during the current backlog review.
  The current 8 MiB limit applies to one text record or one complete JSON
  document, not the total process output. Oversized/malformed structured records
  are suppressed, and invalid UTF-8 or a failing secret source suppresses the
  affected stdout/stderr stream. The future goal is bounded incremental
  structural redaction before Codex's native retention/token/head-tail budgets,
  so a large valid JSON document can deliver safe content without wholesale
  suppression. Never restore completeness by forwarding raw bytes or truncating
  sensitive structure before redaction. Preserve the current safety boundary
  until that work is explicitly resumed and verified.
- **Native Codex memory isolation:** recorded at the user's request on
  2026-10-06. Further isolation design, review and implementation are deferred
  until the user resumes this topic. Existing memory behavior is unchanged.
