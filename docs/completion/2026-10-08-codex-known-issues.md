# Codex known-issue closure, 2026-10-08

Status: known regressions repaired; the scoped non-Feishu follow-up below is
verified locally and in the independent SiCore test environment. Main acceptance
and explicitly deferred capabilities are not implied. Do not merge main,
commit/push, or claim every catalog/provider or failure mode is covered. Work remains local in the existing Siclaw
and paired SiCore worktrees; unrelated dirty changes are preserved.

## Feishu private-only credential preflight

The user now explicitly authorized temporary encrypted bot configuration only
for the isolated test Agent and private-chat testing, with cleanup afterwards.
Readonly preflight verifies the supplied application's official Feishu token
authentication and bot-info lookup. Access tokens/secrets remain in memory;
no credential literals are included in this record or source backups.
The test Agent still belongs to `native-codex-20261006`, is non-production,
and has no existing personal-bot configuration.

The bot already belongs to at least two groups (one-item membership metadata
response has more pages; group names/messages were not printed). Current
SiCore GetChannels unconditionally sets a dedicated personal bot's
group_channel_id, so enabling it is not equivalent to a private-only route.
An additional receiver for the same App can also compete with any existing
receiver. No bot configuration was saved/activated, no WebSocket receiver
started, and no messages sent. The user is being asked to confirm receiver
exclusivity before a private-only setup. This is credential preflight, not
real Feishu/Codex channel acceptance.

Subsequent authorization expands acceptance to both private chat and a
human-selected test group. The user confirms no other receiver and supplies a
rotated Secret (not recorded here). It passes official authentication. The new
Agent-owned encrypted configuration `02bd62dd-b3e9-4bd9-9a99-2f761fddf5e8` is
saved inactive on the isolated Agent, with granted access, guest deny and no
self-service requests. No plaintext Secret is returned. Source-backed operator
reception restriction is implemented: explicit Agent/group selection, private
callback fence, and non-authorizing metadata-only group probe. Targeted tests:
334 pass; full Siclaw: 436 files / 8,918 tests; typecheck/build pass.
Independent Runtime image `079edaff93db392efebc8917b7f0af3e9378481b04d47b8a71fb094b7b60fd1b`,
snapshot `3e08b7cc499270c0d1f7f1ec7a689ff10e8a94e0f65d98e03d7a3ce1a3397e86`
is deployed with zero admitted groups initially; AgentBox remains `63ae580b...`.

Activation is refused with duplicate_app: the same App has another active
personal-bot configuration. User explicitly authorizes locating and disabling
only that old receive binding, preserving its Agent/resources/models/history
and old credential. Normal authorized Agent inventories do not expose the
matching row; two organization API reads are refused (not bypassed). A separate
explicit authorization permits a one-shot deployment-side, same-App read-only
metadata association query returning only config/Agent IDs, org and status.
Its program uses a forced read-only transaction and never selects credential
columns. Query/migration and real Feishu delivery remain in progress. Messages
sent before a test receiver starts are not accepted as Codex delivery evidence.

The user clarifies that the objective is ordinary Feishu-to-Agent conversation,
not further acceptance scaffolding. The temporary Runtime reception scope env
has been removed; normal channel authorization/routing is restored. No source
main merge, Agent resource/model/history change, or old-binding write occurred.
The separately authorized read-only metadata association query completed and
found active config `9c85f0f0-4e46-4dac-abba-0e78da97ce82` on active Agent
`43fa4c8d-28fe-4f00-9197-5ae2e06923a3`, tenant org `test`
`eb0d26e3-c552-4496-9dbc-815827b8d43c`. No credential column was selected.
The normal migration API's preflight is refused with HTTP 403. As promised,
no DELETE/DB write/bypass follows. The new target configuration remains
inactive, and direct Feishu conversation is not yet working. Key rotation
changes external authentication material, not the stored App-ID-to-Agent
binding or its active status. The old configuration owner/authorized tenant
operator must disable that binding before the target can be activated.

### Authorized test-environment receive-binding migration

The user subsequently authorizes unbinding test-cluster Agents and continuing
acceptance. Live checks confirm the validation API uses `sicore-mysql:3306`
inside `sicore-test`; the same-App old Agent is `keytest-agent`, Runtime
`sbx-bj`. Its `is_production=1` is an Agent setting, not evidence that this
database operation targets a production deployment. The maintenance operation
is scoped to the exact config/Agent/App/provider/domain/org tuple above, and
changes only `status` and `updated_at` from active to inactive (one affected
row). Agent/resource/model/history and encrypted credential data remain intact;
no org membership or API authorization rule is changed. This latest explicit
test-cluster authorization supersedes the earlier read-only-only step, not the
ordinary API's tenant gate.

Normal API activation of config `02bd62dd-b3e9-4bd9-9a99-2f761fddf5e8` then
succeeds on `79068105-473b-4417-8935-b4f11c16c5b3`. Read-only follow-up confirms
that it is the only active dedicated configuration for this App. Target Runtime
hot reload reports started=1; a real Feishu WebSocket-ready event is observed
with no Feishu error lines in the bounded window. The browser Channels page
shows the bot Active, selected people. Private identity pairing and actual
human-originated DM/group Codex runs remain pending; setup/connection readiness
alone is not end-to-end acceptance. The old Runtime's cached WebSocket shutdown
has not been independently verified after the maintenance-row update.

### Normal DM identity link and test Web address

The human's actual bot reply leads to the reverse identity-link page, not a
mandatory PAIR step. Existing Runtime p2p PAIR parsing and
`channel.pairPersonal`/`personal-bot/pair` endpoints remain available, but the
current primary DM flow is: message the bot, open its single-use link, sign in,
explicitly confirm the displayed Feishu identity, and resend the message.
Dedicated per-Agent group routing also auto-binds; manual group PAIR belongs
to the legacy shared-App path. The earlier operator instruction to send a
private PAIR code is superseded; no compatibility behavior was removed.

Actual pre-confirmation browser preview succeeds at local port 30104 and names
the expected bot/Feishu identity. The human reported connection refusal at
localhost:3000; live API `FRONTEND_URL` was indeed that wrong address. Only
`sicore-native-validation-api` is changed to `http://127.0.0.1:30104`, and its
rollout succeeds; the new Pod reports that exact public URL. The operator does
not consume the identity invite or press Confirm link. This loopback address
is for the same computer's port-forwarded acceptance only, not a public/mobile
deployment URL. Fresh real Feishu link delivery and human-confirmed identity
association are still acceptance gates.

## Final authorized non-Feishu follow-up (supersedes historical open gates below)

### Additional SSH/netns and history follow-up

The user resumed acceptance and will configure Feishu only after feasible
non-Feishu work is complete. The prior calendar-based Feishu deferral below is
historical, not the current readiness condition. A new authorized, disposable
061 SSH/two-Pod/Skill fixture is separate from the previously verified cleanup.
The existing uncredentialed 062 Host record is left untouched.

Actual `NETNS_POSITIVE_R1` returns eth0 `172.18.240.99`, matching the disposable
061 Pod. `NETNS_NO_FALLBACK_R2` refuses the 062 Pod on the 061 host; it does not
fall back to host networking. No privileged Kubernetes helper was created.

Further cancellation/history gaps are repaired and live-verified:

- A latest-page history poll appended an old error when its preceding anchor
  was absent, then restored the old failed turn at the tail. The following
  surviving neighbour now anchors it, including native-to-DB ID transitions.
  Three regressions and 3,921 Web tests pass. Live `WEB_HISTORY_LATEST_R3`
  stays latest after loading the old MODEL_ERROR history and another turn.
- `NETNS_REFRESH_STOP_R4` really restores process session 50161 after reload,
  but pre-fix `NETNS_CANCEL_CHECK_R5` finds synthetic PID 297440 still alive.
  Native termination is now directly tied to the sealed infrastructure
  operation's owner/process ID, not just an eventual HTTP close. Canceled
  unclaimed tickets cannot launch; unrelated processes are not canceled.
- Silent SSH channels can leave output readers and their SSH chain waiting
  forever for peer acknowledgement. Stop independently destroys local readers
  and idempotently releases the owned chain. Failed-before/passing-after tests
  cover both startup and already-reading races, manual/signal abort and native
  termination/exited notifications.
- The first repaired image still failed `R6/R7`: interrupting a native
  write_stdin wait does not terminate an already-yielded upstream process.
  Product Stop now directly cancels Brain-owned local/cluster relays (including
  its native children), pauses launches and invalidates unclaimed tickets.
  Only a newly admitted user prompt resumes launches. Other public sessions
  have separate relays. Both failed deployment samples remain in history.

Final AgentBox:
`registry-cn-shanghai.siflow.cn/k8s/siclaw-agentbox@sha256:63ae580b8de6607bcf62b8c70d5a1e0e65f70b9898b153cb798835755f70414a`.
Source snapshot `defde8dbe3ea5ff6da905e47a0c1234fa531a2004dbef736c435713f95b90095`;
actual Pod UID `b2c2bbe3-82e9-4c7d-9d4f-d5610100b4ed` confirms deployment.
Seven source-built Linux gates pass, now including the product Stop boundary
on the infrastructure SSH fixture; full Siclaw is 435 files / 8,904 tests,
typecheck/build pass. Web is 476 passing files / 3,921 tests, three existing
skips, typecheck and whitespace checks pass.

| Gate | Additional actual evidence |
| --- | --- |
| SSH netns refresh -> Stop -> real reaping | R12 restores the same native session 26413 and synthetic PID 552961 after refresh. R13 executes one exact pgrep and returns exit 1/no match before the original 197-second deadline; `NETNS_CANCEL_NO_PROCESS_R13`. This supersedes, not erases, the R4/R5 and R6/R7 failures. |
| Pod immutable script, native child, synchronous parent | R8 child `75f70342-2819-49ca-965d-9c77b203a0c2` executes the script once: actual PID 14, ticks 1–6, DIAGNOSTIC_DONE and exit 0. Parent then emits REMOTE_CHILD_PARENT_OK_R8. An initial Skill read lacked the explicit native environment and was denied before a correctly scoped read; no unmanaged-local fallback. This case completed before refresh and is not counted as an in-flight reload. |
| Pod script child refresh -> Stop | R14 child `404b8156-f7a5-4298-99db-222b7b9ef35b`, case remote_child_r9b: independently recorded running PID 74/SID 73 in Pod UID `713c9d86...`. Reload restores the same child/wait; Stop gives Cancelled and tool error with no DIAGNOSTIC_DONE. Independent same-UID/SID inspection finds no active process. R9 completed naturally and is not a cancellation pass. |
| SSH binding withdrawal | R11's one actual exec row `ced3ebf7-53fd-4b6a-818f-52bc36bb1e66` is refused before transport, then NETNS_REVOKED_R11. No alternate host/network fallback or retry. |

The minimal disposable Pod image has no ps/pgrep. Independent script checks
therefore used its existing Node to read only process metadata in that
credential-free, no-SA-token Pod. No model command grant or Skill modification
was added. Test-only shell-match/stream-fixture failures and silent-channel
cleanup hangs were diagnosed before publication; bounded Linux gate execution
prevents a stalled fixture from hanging the build indefinitely.

This round's cleanup is independently verified: new SSH/kube credentials,
Host/Cluster/Skill records and bindings are deleted, both named Pods and the
dedicated SA/Role/RoleBinding are absent, and original bindings are exactly
restored (one cluster, zero hosts/Skills/MCP/knowledge). The pre-existing
uncredentialed 062 record is unchanged. Acceptance histories/screenshots stay
as audit evidence. Post-cleanup same-session R15 passes: actual cluster_list and
host_list rows (seq 215/216) succeed with counts 1/0; withdrawn Skill cat is
refused (seq 218), then CLEANUP_CONTINUATION_OK_R15 (seq 219). Refresh preserves
the result; no job replay or native HOME/history replacement.

Final screenshot review also found long unbroken user command paths overflowing
a narrow chat panel. At a real 689px viewport, a 768px bubble began at x=-139.1
inside a 573.8px parent. The CopyableMessage wrapper now fits/maxes at its parent
and permits anywhere word wrapping; actual recheck gives x=55.1 and width=573.8,
with no text truncation or horizontal clipping. One renderer regression and the
full 3,921-test Web suite/typecheck pass. Runtime/security behavior is unchanged.

The user explicitly authorized the temporary readonly MCP/diagnostic Skill,
internal Shanghai source transfer/build, independent registry publication and
deployment only to `sicore-test`. The first build attempt was rejected before
execution; it was retried only after that specific authorization. No credentials
were transferred. Upstream Codex remains unmodified at
`d4684bba63aba4c941d5a251054609e722b64779`.

Four further issues were found and repaired:

- The private Codex-home Skill symlink advertised to the model was rejected by
  the executor. Trusted, selected Skill read aliases now translate only the
  exact still-valid symlink into an already-authorized canonical Skill root.
  Private home/config/state, parent listing, writes, swapped links and nested
  credential escapes remain denied. No arbitrary shell/Python support or broad
  home access was added. Native `cat` and immutable approved script execution
  succeed in the rebuilt image; two additional policy tests pass.
- Web history sorted fractional ISO timestamps lexically, so a plan reset
  `.41Z` incorrectly followed updates `.417Z`, dropping a completed task after
  refresh. Existing persisted `seq` is now kept distinct from native item-local
  sequence and used for ordering; legacy timestamps compare numeric instants.
  Three regressions cover the real reproduction. Live refresh keeps 1/3.
- Cold-lost foreground rows kept the composer busy although Runtime explicitly
  reported `running=false,state=idle`. Web now settles those rows as interrupted,
  not completed, and marks unfinished native children failed with an interruption
  reason. Missing/failed probes, genuinely active turns, detached legacy jobs and
  peer liveness are not treated as cold loss; newer input/SSE activity wins over
  an older probe. Stopped plans keep their unfinished ledger but stop animating.
- Cleanup exposed a separate continuation bug: changing the selected Skill set
  chose another native HOME while retaining the old thread ID. The fixed binary's
  generated `ThreadResumeParams` schema has no `path` field, so the adapter's
  attempted rollout-path override was ignored and resume failed in zero seconds
  with `no rollout found`. After separate explicit user authorization, private
  sidecars now persist original HOME and a stable owner stamp. Legacy sidecars
  authenticate that HOME by recomputing its original hash from the current owner
  and historical Skill-link metadata, even when a withdrawn target is gone.
  Cross-owner/Agent/anonymous-session mismatches and redirected directories fail
  closed without discarding metadata. New-conversation scope and native-memory
  storage/behavior are unchanged; no DB/history/memory copy or Rust patch. All
  execution grants and MCP configuration are freshly resolved, not restored from
  the old HOME. The unsupported resume parameter is removed.

Actual public session: `57b3a394-e1dd-47f8-9be7-c9631eded525`.

| Gate | Actual evidence |
| --- | --- |
| Tool-run refresh -> recovered progress -> Stop | `refresh_cancel_05`: one real MCP Pod read, started `1791439052440`, canceled `1791439064181`, no finished event; same tool and Stop restored after reload. |
| Native JS authorization/opacity | `MCP_SCOPE_JS_07`: both exact Pods read once, trusted tenant injected, secret canary redacted before JS output; process/require/fetch/WebSocket absent. Wrong namespace/tenant/Pod and extra identity fields refused; spoofed writer absent. |
| Child refresh and synchronous parent wait | `CHILD_REFRESH_08`: child `e49bfa42-5d1e-4ca1-be7f-8ddee37b6ae8` and parent wait remain visible after reload. One upstream read, real child report, then `CHILD_REFRESH_PARENT_OK`. |
| Approved Skill read/run | `SCRIPT_REFRESH_09`: projected Skill read succeeds; immutable heartbeat runs once, same process session 53109 polled until actual `DIAGNOSTIC_DONE`. This sample completed before an in-flight reload and is not counted as that timing gate. |
| Approved script refresh -> Stop | `SCRIPT_STOP_10`: reload preserves native process session 20291; Stop produces Aborted and authoritative stopped state. Exact-script process metadata check finds no script or descendants remaining. |
| Parent Stop propagates to child | `CHILD_STOP_14`: child `2fa37d38-703c-4761-b280-39da8cdfdbce` becomes Cancelled after reload/Stop; first real read canceled, later two never dispatched; no late success. Cases 11/12 finished too early and are not counted as cancellation passes. |
| Active-child cold interruption and subsequent usability | `CHILD_COLD_15`: exact isolated AgentBox recreated. Two reads started once during the container's shutdown grace; no third or replay. Cold history shows interrupted/failed, not forever Running; `COLD_RECOVER_16` succeeds in the same public session. This proves correct interruption/history/usability, not transparent continuation of external work across a crash. |
| Complete Skill preview | `SKILL_PREVIEW_17`: native apply_patch writes a session-owned draft; real preview contains SKILL.md and notes.txt. Open/copy attachment/reload/reopen pass; disposable source draft consumed, no publication/loading/execution. |
| Structured feedback | `FEEDBACK_18`: real disk custom entry receipt `b1ca2623`, exactly one matching record, correct Agent/session, actor present, rating 4 and temporary tag. This is not a human vote or native memory. |
| Overlap/steer + reload | `OVERLAP_19`: additional guidance survives refresh, exactly one persisted user row (seq 120), all three distinct reads execute once; final `GUIDANCE_ACK_19` appears once. |
| MCP revocation before dispatch and after response | `MCP_REVOKE_20`: binding removed during the held read; that result is refused. Same captured JS function then fails in 18ms; no upstream `revoke_20_after`. Stateful fixture's final counter is 14 reads, zero writers, with no duplicate case dispatch. |
| Skill-scope change continuation | Case 21 is the real pre-fix failure, retained as evidence. `RESUME_OWNER_FIX_23` now succeeds in the original public session, cluster/host metadata gives 1/0, withdrawn Skill cat and script requests fail before execution. Sidecar preserves native thread `01a11a12-0ed4-78d0-a2f5-c6980a943e9e`, original HOME `d71c4c...`, and adds home/ownerKey. |
| Hard refresh after continuation repair | `POST_REFRESH_SCOPE_24`: native JS globals/actual tool metadata checks pass, `WITHDRAWN_MCP_UNAVAILABLE`; removed MCP is absent and the same original conversation remains usable. New-session case 22 independently verifies resource counts but cannot use tool_search when no deferred tools exist; that discovery attempt is not counted as a full pass. |

The first stateless MCP fixture did not associate cancellation notifications with
the original request. This was a fixture protocol defect, repaired with stateful
SDK sessions; it is not reported as a production Codex regression. Local SDK
auth/scope/cancellation checks pass. A test requiring tool discovery initially
prohibited every other tool and returned unavailable; explicitly allowing native
deferred-tool discovery resolved that test constraint, without opening access.

Current deployed AgentBox is
`registry-cn-shanghai.siflow.cn/k8s/siclaw-agentbox@sha256:fcd51017ce55832ec765b090ec58b9c610c7d856c312682a0c754655d18449e5`,
source snapshot `53b4f3cd9db6382f9f967930b88a0acd0d9af7da07bdc7c6e42e72044d08047b`.
Actual Pod UID `3d311003-901b-49cb-bc57-02e077544439` verifies this final image.
The preceding Skill-alias image was `8970e11d...`, snapshot `abfe2a47...`; Pod UID
`dd78e2ec-0377-4ab5-920a-5151f66bf30e` verified it before the deliberate cold test.
Runtime/API digests remain `bdf83421...` / `acb5a600...`.
Only independent Runtime's `SICLAW_AGENTBOX_IMAGE` changed; normal deployments,
schema/database and shared reader Role are unchanged.

Linux source-built suites pass: same-thread native HOME resume across Skill
withdrawal (including old sidecar, intact-file read/script denial, cross-owner
refusal before model, unchanged new-conversation scope and no DB/memory copy),
immutable Skill local/SSH shell+Python and Pod
argv fixture, executor UID 1001/process-tree cancellation/session isolation/stdin
denial/live redaction, MCP native discovery/redaction/revocation/child/resume,
child execution fence and live text before completion. These are protocol tests,
not substitutes for the physical-target evidence above or privileged node/netns
deployment acceptance. The executor fixture needed its documented readonly
kubectl mount; the initial missing-mount failure was corrected, not bypassed.

Full Siclaw: 433 files / 8,894 tests, typecheck/build pass. Final paired Web:
476 files / 3,917 tests pass, three existing skips; typecheck and whitespace checks
pass. A passive-effect URL assertion in Ticket review now waits for that effect,
preserving the assertion. A default-sandbox run could not listen on local mock
ports (EPERM); the permitted local-network rerun passes.

Cleanup is verified: new MCP/Skill records and bindings, synthetic MCP Secret and
ConfigMap, both Pods, MCP Pod/Service/NetworkPolicy and both dedicated
SA/Role/RoleBinding sets are removed. Original one-cluster/zero-host/no-Skill/no-MCP
bindings are restored exactly. Earlier SSH credentials/Host/Cluster cleanup stays
valid. Acceptance histories, screenshots and the tagged feedback receipt remain
audit evidence; the preview was never saved as a tenant Skill.

Feishu is still deferred to 2026-10-09. Native memory, large incremental structured
redaction, Portal UI, cross-Agent handoff, PTY/free shell and future write approval
remain outside this pass. Only Responses and the previously live-accepted
gpt-5.6-luna/gpt-6-astra are acceptance-covered; the current catalog also lists
other models/protocols, which are upgrade gates, not silently certified here.
Privileged node/netns positive deployment coverage is not claimed from the
two-Pod-only authorization. MaaS latency observations do not establish an SLA.

Durable screenshots: `child-running-after-refresh.png`,
`script-running-after-refresh.png`, `child-stop-after-refresh.png`,
`cold-child-interrupted-static.png`, `native-skill-preview-files.png`,
`mcp-revocation-verified.png` in the artifact directory named below. Current
source backups supersede earlier transient paths. No commit/push/main merge.

## Superseding Web/SSH/Pod follow-up

The interrupted temporary SiCore checkout was recovered at
`/private/tmp/sicore-native-recovered-20261008` from its exact base and this
conversation's patches. The ordinary Chat renderer, not native/Runtime delivery,
was hiding active Markdown prose. The existing live-prose mode now applies to
Chat; duplicate evidence-card insertion and Completed labels on interrupted
native partials are also repaired. Full Web now passes 476 files / 3,911 tests
with three existing skips; typecheck and targeted native-media/question/Chat Go
tests pass. This supersedes the presentation-open conclusion below for live
text and ordinary active Stop, not every reconnect/cancellation variant.

Live session `af499989-2474-4421-855d-90fe3585caf3` verifies visible incremental
text with Stop present, authoritative stopped status and interrupted history,
brokered 061 SSH reads, two restricted Pod exec reads, explicit Forbidden outside
the two Pod names, and a real failed SSH call after binding revocation. All new
credentials/records/bindings and fixture Pods/SA/Role/RoleBinding are removed;
the original cluster and shared reader Role are unchanged. An operator direct
credential-file diagnostic was rejected and not executed; testing continued
through the broker, with no bypass. The original 062 metadata is untouched.

The live refresh recovers a complete reply, but completion occurs before Stop
on the restored page, so refresh -> still-active -> Stop remains unverified.
Controlled real-hook SSE tests cover split UTF-8/frames, EOF reattachment and
deduplication. Claude's generic chat-reliability work is reference only, not
merged or described as a Codex-specific optimization. Remaining gates and exact
evidence are in the paired SiCore
`docs/completion/2026-10-08-native-web-stream-and-infra.md`.

Durable source backups/screenshots are under
`/Users/lrli/.codex/visualizations/2026/10/07/01a11408-ace8-7b81-bb0e-fb80d9e0e774/`.
Older `/private/tmp` artifacts named below no longer exist after interruption;
do not present those files as currently available evidence. No runtime source,
image, upstream pin, database/schema or normal deployment changed in this pass.

## Closed issues and evidence

| Issue | Repair and verification |
| --- | --- |
| Trailing blank line in `investigation-mode.ts` | Removed only the extra EOF line; all 19 deep-investigation regressions and `git diff --check origin/main` pass. Prompt contents are unchanged. |
| Native image rejected/routed to OCR | Existing local fix delegates image handling to native app-server instead of Pi's modality filter. Real unique-image/history tests and pinned native input-image checks pass; the API has zero OCR attempts for that test. |
| Parent returned before child synthesis became visible | Existing execution-only fence and bounded Web reconciliation tail retain native ownership. Real `CHILD_EARLY_R2_PASS` arrives without reload or a fake human-message bubble. |
| Native question UI and stale quick replies | Existing structured Question card above the composer persists bounded identity/descriptors. Real single/multi/custom, close/reopen, hard reload, Skip and Stop cases pass. Older pre-descriptor histories are not migrated. |
| 25 failing Web baseline tests and four blocked suites | Selected test realms replace Node 25's incomplete process-wide storage; pure Node tests retain SSR semantics. Before repair, 20 affected behavior tests fail on storage, after repair 42 focused tests pass. Source guards retain real permissions/version-publication boundaries while recognizing Ticket instance prompts, tenant-only organization selectors and documented personal-Agent quick tests. Two imports use the existing toast-duration wrapper, and five bilingual hints are concise without changing endpoints or credentials. Full Web: 474 files / 3,903 tests pass, three existing tests skipped; typecheck passes. No tests or business guards were disabled. |
| JWT leaked by Next development URL logging | Replaced the validation-only mitigation with a dedicated policy wired to the real Next config. `logging: false` disables the automatic development URL logger; application warnings/errors and Runtime/API business audit are unchanged. A query-ignore-only policy is insufficient: Next 16's fetch-cache-warning branch prints a full URL even without ordinary fetch logging. Two policy/config regressions pass. No auth transport, token lifetime, shared keys or RBAC changed. |

The test-only Storage setup is separate from browser persistence: no production
storage implementation or session/draft behavior is replaced.

## Additional real cold-resume evidence

The idle AgentBox was reclaimed naturally. The existing public session
`ecbf9ca7-fa57-472b-a94c-52e83927fd60` resumes in Pod UID
`87eb8182-6af7-42d5-84f2-fcc78e9da73d`. Its native thread remains
`01a1175e-6ec0-7d32-8695-f511724846d3`, and the next harmless response completes
in about nine seconds. Native rollout contains three actual usage records,
summing input 36,852 / output 154 tokens, exactly matching the visible UI.
This covers idle root cold resume and replay billing, not active-child cold
restore or every recovery/concurrency variant.

## Not closed: long model-response delay

For configured model `gpt-5.6-luna`, native function output is recorded at
2026-10-08 01:17:47.690 Asia/Shanghai. The private native diagnostic database
records HTTP response headers received with status 200 at 01:24:06.764; native
reasoning/final items follow at 01:24:07.007–01:24:07.038. Thus the long wait is
already inside Codex's model HTTP path, before that response's headers, not an
unsubmitted card answer or delayed Web rendering. The response supplies no
standard processing-time header in the checked allowlist.

This does not establish whether the delay is model-service queueing, network
transport, connection handling or retries. No speculative timeout/retry change,
provider fallback or raw diagnostic/header logging was introduced. A bounded
query selected only this native thread/time window and emitted timestamps,
categories, HTTP status and numeric fields, never body/header credentials.
The user confirms that MaaS is occasionally slow and asks for more observation.
Treat this as a model-service latency observation while checking normal waiting,
Stop, continuation and billing. It is not proof of a Siclaw input-transfer bug,
nor a latency SLA. Do not force a timeout/model change to conceal it. Further
service-side attribution still requires MaaS request metadata, not keys.

## Not closed: real text-stream presentation

Long arithmetic-output fixtures F/G showed the first visible prefix only when
the whole reply was already complete, even with a prefix-based selector. These
are observations, not completed in-flight cancellation tests. The canceled C
fixture was stopped before native dispatch; B and the earlier stream fixture
finished before Stop and are not counted as successful cancellation.

`codex-live-text-smoke.mjs` uses the actual fixed app-server and holds native
Responses completion until a text delta reaches the Siclaw brain. It passes,
proving this boundary can stream rather than merely replaying a completed reply.
The real Runtime also receives G's assistant start about 6.75 seconds before
its end, but that alone does not establish whether text deltas were delivered.

Safe diagnostics now count native `item/agentMessage/delta` receipts/retry
notifications and Runtime raw/normalized text-delta receipts, with bounded
native-turn tracking. They record only validated native IDs, counts and receipt
times: no content, error bodies, request headers, tokens or provider timings.
Receipt time is not HTTP TTFT or billing telemetry. Targeted diagnostics and
SSE tests pass 104 tests, with passing typecheck/build. Full regression now
passes 433 files / 8,888 tests. All eight source-built Linux suites pass,
including the completion-gated live-text check. The independent diagnostic
images are built from runtime snapshot
`803e8001a9df5b07fd654f98ff686efa66f95b2469c2ae73adfd8439adab1311`:
AgentBox `1487c2c237d012d63386af82d86919ece2fbe59f505776e4aaa9887557c1eb4e`,
Runtime `bdf83421ab5af82e0c44c8ccacdf8d01ea86a87511b561bef33d1871bb05f4e8`.
Only the existing native-validation Runtime/AgentBox are updated for real-stage
measurement; API, normal deployments, database and permissions are unchanged.
Main remains unmerged; do not close this presentation issue without the stage
evidence.

Real diagnostic sample H verifies the new images (AgentBox Pod UID
`10d7bb13-68cc-4c92-909d-11e872b21765`). Native receives 852 public text deltas;
Runtime receives and normalizes the same 852. First receipt timestamps are
`1791402579702` and `1791402579703` respectively, last receipt is
`1791402584467`, and completion receipts follow at `1791402584569` and
`1791402584577`. This proves no whole-reply buffering at those two boundaries;
the first delta precedes completion by about 4.8 seconds, with zero native
retry notifications for H.

Do not treat the browser result as a confirmed frontend buffering defect yet:
the automation text locator reports zero matches for a visible model paragraph
which the readonly DOM evaluator reads verbatim, while both its CSS visibility
and dimensions are valid. Foreground/background variants and a DOM polling
variant still do not establish in-flight cancellation. MutationObserver is not
available in the browser tool's readonly evaluation scope. No DOM was mutated
and no alternative browser-control technology was used. Browser-side stream
acceptance remains open; do not loosen model-routing or privacy controls to
work around an inconclusive UI check.

## Acceptance still needing a fixture or external coordination

- Actual SSH/Pod exec/node/netns positive paths need an already-authorized test
  target and binding. The current namespace reader remains Pod get/list/watch;
  no Role, credential or resource scope was expanded to make a test pass.
- The user explicitly defers Feishu testing until 2026-10-09 Asia/Shanghai. Do
  not test or message Feishu today. Tomorrow's human-triggered CLI bot still
  needs its actual Agent/Runtime mapping; local/pinned protocol checks are not
  channel acceptance.
- External bound MCP, skill preview/feedback, active-script/child cancellation,
  overlaps and active-child cold restore retain their specific pending gates.

Deferred memory isolation/integration, large structured-output incremental
redaction, Portal UI, cross-Agent handoff and future write approval remain out
of scope. This issue-closing pass does not resume them.

## Verification artifacts

Private directory: `/private/tmp/siclaw-child-channel-build.r76oYy/`.
Relevant logs: `known-issues-storage-before.log`,
`known-issues-storage-after-r2.log`, `known-issues-source-contract-after.log`,
`known-issues-web-full-final-r3.log`, `known-issues-web-tsc-final-r3.log`,
`known-issues-logging-final.log`. Screenshot:
`known-issues-cold-resume-pass.jpg`.

Final current Siclaw rerun passes 432 files / 8,886 tests, typecheck and build.
The final Web rerun passes 474 files / 3,903 tests, with three pre-existing
skipped tests and a passing typecheck. Both worktrees pass diff whitespace
checks; Siclaw also passes the comparison against `origin/main`. Core logs are
`known-issues-siclaw-full-final.log`, `known-issues-siclaw-tsc-final.log` and
`known-issues-siclaw-build-final.log`. Web logs are
`known-issues-web-full-final-r3.log` and `known-issues-web-tsc-final-r3.log`.
The first Web typecheck during a live Next config restart observed transient
missing `.next/dev/types` files; the settled, nonincremental rerun passes.

The
currently deployed Runtime/API/AgentBox digests remain the prior independent
native-validation set; no normal deployment, database migration or upstream
Codex source was changed by this pass. Local Next serves the revised branch UI.
