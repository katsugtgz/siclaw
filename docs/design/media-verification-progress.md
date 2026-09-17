# Media verification progress and reuse

Image verification scans the draft's media references, then selects pages whose
page-and-image fingerprint lacks a matching receipt. Missing historical receipts
also select old pages. Transcription separately reuses a cache entry only when
the image path and content hash match. Whole-draft inventory is not incremental
model workload.

The compiler writes `authoring/MEDIA_VERIFY_PROGRESS.json` for each group. Version
1 binds it to `run_id` and `group_id`; consumers must reject another run's copied
record. It reports `transcribing`, `comparing`, or `complete`, selection reasons,
image cache hits/new transcriptions/failures, page comparisons/failures, and
`last_progress_at`. Group completion does not imply draft convergence: findings
can inject a repair and start another group. Failure, cancellation and recovery
remain owned by the authoring operation.

Progress and transcript artifacts sync at most once per ten seconds plus group
phase boundaries. This dedicated path never syncs an in-flight Candidate batch.
The regular workspace sync also retries these artifacts. Progress counters track
completed work; failures can update the snapshot without advancing effective
progress. No percentage or completion time is inferred from inventory size.

Transcripts are atomically saved per image under
`authoring/media-transcripts/<sha256-of-image-path>.json` immediately after a
successful transcription. This avoids the aggregate cache exceeding the existing
per-file workspace sync limit, and retains completed siblings when a group is
interrupted. Legacy `MEDIA_TRANSCRIPTS.json` remains readable; its entries migrate
to shards when media verification begins. Shards take precedence. Old compilers
do not read shards and can repeat transcription after rollback; Wiki correctness
does not depend on cache availability. No deployment settings change.

Runtime relay failures retain the `relay_failed` recovery classification while
their safe `exception_class` identifies artifact persistence, turn persistence,
event commit, event acknowledgement or stream failure. Original causes remain in
Runtime logs. The names locate the failed boundary, not its underlying root cause.
