# Compiler harness contracts and evaluation

The control plane freezes Raw and execution policy. KBC owns scoped tools,
checkpoint receipts and quality accounting. Claude Agent SDK and Pi execute the
same bounded responsibility; engine selection does not change publication policy.

## Writable artifacts

Served compiler and planner Write/Edit tools use the existing
`KBC_MAX_SYNC_FILE_BYTES` limit (1 MiB by default), measured in UTF-8 bytes including
metadata. Before mutation, served Write/Edit tools project producer timestamps,
source IDs, evidence markers and source positions using the same transformations
as the controller. A page whose projected bytes exceed the limit is rejected
while the worker can still split it; the old file stays intact. Synchronization
also checks the final provenance-stamped payload before enqueueing it. An
oversized inherited file can be edited down to the budget; large tables should be split into linked
pages. Ordinary periodic synchronization reports uncollectable files and retains
previous copies. An ACK-backed or completed checkpoint rejects an incomplete
workspace rather than silently sealing it. A legacy oversized/unreadable artifact
therefore requires repair; failed-save retention must not be reported as a fully
saved draft. A deterministic artifact/cache failure emits the recoverable
`workspace_checkpoint_blocked` event and appears in `/health.checkpoint_blocked`.
Any deterministic artifact error takes precedence over transient read failures
in the same checkpoint. The box retains unsaved bytes and checks metadata for
repair instead of repeatedly attempting the same invalid save. Uncertain I/O or
transport failures get three fast attempts, then an explicit blocked state with
60-second recovery probes: storage can recover without changing file metadata.
A changed file triggers an earlier retry. The admission fence stays active until
a complete checkpoint ACK; new chat and command requests are rejected before
intent mutation or message queueing, with an actionable save-blocked message. This is a blocked save, not a
completed or durable recovery; do not retire the box before preserving its files. There is no new deployment setting.

## Whole-page media evidence

Image comparison visits every character of the page using bounded overlapping
segments and a single page deadline. A malformed result, failed segment or timeout
leaves the whole page unverified. Duplicate findings at segment edges are merged.
An oversized image transcript is a failed transcription, never truncated proof.
The existing exhausted outcome remains distinct from passed.

Media verification receipts use a new contract fingerprint: old prefix-only
receipts cannot certify that the new full-page pass ran. Transcript cache hits
require the full image hash, model ID and prompt/contract digest. Legacy shards
remain readable but are refreshed before reuse. This can increase verification
work on the first run after upgrade. Red-blue survey caches also include exact
Raw/Wiki bytes and the judge's model, instructions and scope, including same-sized
source replacements. No model credentials are stored in these identities.

## Bounded workers

A machine-selected stage contract accompanies every internal session. Map,
reduce, final review, ledger repair and media repair keep their assigned scope;
they can consult other evidence without opening another approval cycle or
repeating a full-library audit. The shared prompt retains source fidelity,
uncertainty, provenance and owner-ruling requirements. A model-generated ticket
classification is not proof of a source error. Owner acceptance of current Wiki
closes a disposition; it does not certify that a pending ruling was applied.

## Reproducible evaluation

Use the same frozen Raw, reviewed question set, model, budgets and owner policy.
Run Claude and Pi in separate workspaces, each with its own caches and checkpoint
lineage. Also compare the previous/current harness under the same engine. Record
warm and cold cache runs separately. Do not run a benchmark against a live writer
or reset a production library to make a fixture.

Include small Markdown, cross-document contradictions, exhaustive tables,
large multi-batch corpora, PDF/image sources and injected recovery failures.
Preserve reviewed reference answers outside the blue reader's allowed roots.
Record provider failures separately from structural/content failures. Sample
load-bearing facts and table rows against Raw; source-accounting closure alone
is not semantic coverage. Record how many claims, critical facts, questions and
tickets were actually reviewed. Missing grades remain unmeasured.

`kbc/tools/harness_compare.py` compares two recorded results without invoking a
model or writing to the platform:

```sh
python3 kbc/tools/harness_compare.py --baseline baseline.json --candidate candidate.json
```

Each private result file has this shape (values below are illustrative; populate
metrics only from actual observations and reviewed outcomes):

```json
{
  "schema_version": 1,
  "raw_sha256": "<SHA256 of the frozen Raw manifest>",
  "evaluation_sha256": "<SHA256 of the reviewed evaluation set>",
  "policy_sha256": "<SHA256 of the common model parameters, budgets and owner policy>",
  "model": "<same model for the paired comparison>",
  "engine": "pi_agent",
  "source_revision": "<exact compiler commit>",
  "outcome": "completed",
  "metrics": {
    "elapsed_seconds": null,
    "model_calls": null,
    "input_tokens": null,
    "output_tokens": null,
    "recoveries": null,
    "human_interventions": null,
    "claims_checked": null,
    "unsupported_claims": null,
    "graded_questions": null,
    "passed_questions": null
  }
}
```

The comparator refuses mismatched identities, preserves missing measurements and
never derives billed cost or production readiness from token counts. It checks
record consistency, not the truth of supplied measurements. Repeat paired runs
before estimating completion rate, latency distribution or semantic parity.
Unit and synthetic SDK tests establish protocol behavior only; they are not a
real-corpus quality or cost result.

## Deferred investigations during finalization

The catalog-review receipt tracks the semantic contents of `REVIEW_NOTES.json`.
A tail ledger/media investigation reopens that responsibility before commit,
without invalidating unrelated semantic/introduction units or quality receipts.
Timestamp-only rewrites do not invalidate receipts. Candidate changes still
invalidate their actual read dependencies, and the bounded final-pass limit is
unchanged. Legacy catalog receipts without the investigation hash are revisited. Investigation still precedes escalation: pending notes are not promoted
to owner tickets mechanically. The final reviewer must make that decision through
`file_ticket` with its existing evidence requirements.
