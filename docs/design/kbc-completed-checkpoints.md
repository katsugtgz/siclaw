# Completed-unit checkpoints

An ACK-capable compiler emits `completed_checkpoint_id` on `syncArtifacts` only
when it has a completed unit to seal: the initial plan before batch one, a
completed map batch, or a completed reduction. The UUID stays on the retained
frame during replay. Runtime forwards it on the same atomic
`capability.persistArtifacts` call, before returning the artifact ACK.

The consumer stores a separate completed workspace snapshot. Periodic sync,
failed-turn saves, and reconnects continue to save working files without moving
that completed checkpoint. Starting from an interrupted working tree does not
seal it as a completed boundary: the successor inherits the prior completed
snapshot independently, until its next successful unit.

The matching SiCore implementation handles confirmed Stop, generation fencing,
local/platform continuation and final validation. Apply its migration and API
support before Runtime and KBC. An older consumer can still save the ordinary
artifacts but cannot offer stopped continuation. Old boxes cannot retroactively
prove an earlier boundary; never infer one from a chat transcript or a done flag.
No new deployment configuration is required. This protocol does not publish a
partial candidate or replace Stop's cancellation semantics.
