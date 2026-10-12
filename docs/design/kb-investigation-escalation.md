# Investigation before owner escalation

## Outcome

Compiler uncertainty is saved without automatically becoming an owner question.
A question is escalated only when the compiler can explain the relevant evidence
already checked, a concrete affected answer, and the fact or decision the owner
must supply. Missing checks, infrastructure failures, optional reviewer disagreement
and later-batch dependencies remain internal work. These declarations express the
compiler's judgment; field validation is not proof of semantic correctness.

## Lifecycle

`file_ticket` defaults to `review_action=investigate`. It writes a bounded,
checkpointed `authoring/REVIEW_NOTES.json` record. `resolved` requires the evidence
and conclusion. `needs_owner` requires `investigation`, `answer_impact` and
`owner_decision`. Map/reduce/repair workers defer owner escalation until final
review. The existing final catalogue session examines deferred notes using all
completed batches; no additional reviewer agent is introduced. Unresolved notes
remain visible even if a model does not complete its investigation.

Read existing investigations and tickets before recording an issue. `review_id`
reuses a known issue across rewordings. For historical tickets without a matching
investigation, existing_ticket_id binds only to an exact existing ledger entry;
unknown IDs and contradictory bindings are rejected. Repeated linking reuses the
previous investigation rather than creating duplicates. Ticket identity is reserved before writing,
so retry cannot manufacture another ticket. Rediscovering an inherited ticket refreshes its current operation/generation stamp
even when escalation is deferred, so promotion cannot mistake an active investigation
for a conflict that disappeared. Only detection fields change; existing owner answers,
closure state and application receipts are preserved. Investigation resolution cannot close an
already escalated ticket. Old tickets are not deleted or automatically reclassified.
Served Write/Edit cannot bypass the tools by writing the two ledgers directly.
Local authoring without hosted tools should retain investigation notes in its
working copy and use the platform's existing reviewed proposal workflow.

Technical self-check residuals remain in SELFCHECK.json. They no longer create
"retry or accept" business questions, and unchanged failed repairs stop instead
of spending the remaining allowance on identical work. Security, scope restoration,
source integrity, byte budgets, artifact ACK and final commit checks remain intact.

## Review cost and incremental scope

New execution settings default optional image review to off in both Sicore and
KBC. Explicit on policies and old frozen attempt settings remain supported.
Compiler instructions require reading actual images together with nearby source
context when adopting image-derived facts. Independent image review, when enabled,
offers hypotheses rather than orders to replace values or create tickets. Numeric
coincidence no longer silently dismisses a finding.

The old image scheduler enumerated every unverified page in the library. An
incremental self-check now persists media_review_pages (affected, authorized and
actually changed pages); the scheduler uses that scope across recovery. Old images
on changed pages can still need comparison. Unchanged image transcriptions retain
their content/model/prompt cache. Historical unverified pages outside the update
remain unverified; scope filtering does not manufacture pass receipts. Missing old
scope metadata retains the previous full pending scan. Full compile remains full.

Automatic PK does not run a full-library Q&A evaluation after a scoped incremental
update. Independent explicit testing remains available. Deterministic whole-library
coverage/link scans are retained. Exact-file semantic review receipts survive
unrelated page additions; directory searches, catalogue lookups and negative search
results remain membership-sensitive. Old receipts retain conservative invalidation.

## Control plane and compatibility

Sicore shows internal investigations separately from questions requiring answers,
and displays technical residual details. The owner ticket and Dev MCP expose the
compiler's escalation rationale. Internal notes do not alter readiness or ticket
closure. No database migration, new environment setting or dependency is introduced.
The API authoring kit is generated from the exact companion compiler commit.
Deploy the paired changes for default policy and UI alignment; do not rewrite
running tasks' frozen settings merely to apply new defaults.

## Validation and limits

Regression cases cover deferred-to-final escalation, self-resolution, corrupt
ledger preservation, stable identity with rewording and failed writes, owner-answer
preservation, durable synchronization, explicit review opt-in, incremental scope,
negative-search invalidation and no-progress termination. Existing compiler and
control-plane suites check persistence/closure compatibility. Real-corpus completion
time, answer accuracy, incorrect-edit rate and owner-actionability require a frozen
A/B corpus run; test counts do not establish a measured speedup or quality gain.
