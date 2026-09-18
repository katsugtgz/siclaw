# Compiler image upgrades at rest

Runtime checks a bounded, rotating set of idle capability runs on its existing
watchdog tick. Only KBC profiles with a known different desired image qualify.
Running compiler turns, batches, background verification, recommendations and
live test sessions remain on their current box until their work finishes.

The consumer's read-only `capability.fetchInput` ref `upgrade-admission` returns
`version`, `run_id`, `allowed`, `continuation`, and `reason`. An open operation
qualifies only if it is a compiler operation with a frozen input and valid
execution configuration. User cancellation and non-continuable mutations are
excluded. Closed operations can retire without launching another compile.

Runtime then calls `POST /prepare-upgrade/:run_id`. The box checks actual
quiescence, fences HTTP work admission, migrates legacy transcripts to shards,
and forces a workspace snapshot through the existing durable artifact ACK.
It returns `ready` only after acknowledgement. An unsupported protocol, busy
producer, unsyncable artifact or failed flush leaves the old box in place.
A failed flush reopens admissions; successful preparation is idempotent and
keeps admissions fenced until retirement.
The health response identifies a prepared handoff so a restarted Runtime can
finish it even if the desired image was rolled back in the meantime.

After preparation, Runtime persists the retirement intent in its existing run
checkpoint before stopping the old box. A restarted Runtime finishes that
retirement without spawning another box under the old run ID. Runtime stops
the old box before reporting completion. An
unfinished compiler is settled with `runtime_failure` / `image_upgrade`, using
the existing bounded recovery lineage to create a new run with the desired
image. Saved Candidate pages, media shards, frozen sources and model settings
are inherited by that continuation. A finished operation is simply closed.
For an explicitly consumer-approved terminal operation, preparation skips the
workspace write: the persisted attempt is already terminal-fenced. It still
requires box quiescence and fences new admissions before retirement.
User-stop settlement wins races and does not schedule recovery. Relay closure
during an owned retirement cannot replace its upgrade outcome with relay_failed.

Deploy consumer support before Runtime and KBC. This introduces no Helm or
environment-variable contract. Existing boxes without the preparation endpoint
are conservatively retained; their generic idle status cannot establish that no
background worker is writing. The first transition from such a legacy box needs
the existing controlled recovery process. Once boxes support this handshake,
later releases can replace quiescent boxes automatically. Local external boxes
are excluded because Runtime does not own their lifecycle.

Image upgrades do not resolve upstream billing restrictions or replay a failed
request in place. Subsequent compilation uses the existing recovery admission,
retry limits and user-action boundaries. The new logs identify deferred idle
maintenance, checkpoint acknowledgement and completed image retirement.
