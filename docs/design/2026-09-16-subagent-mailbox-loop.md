# Active-turn subagent mailbox loop

This supersedes the HTTP-owned join/synthesis loop described in the September 9
subagent notes. It follows the execution boundaries observed in Codex v2, adapted
to the installed pi SDK rather than replacing/forking its agent loop.

## Runtime first

AgentBox chat sessions (including channels) launch single and batched subagents
asynchronously. `spawn_subagent` returns a job/resume handle, never a promise that
the assignment is already done. The active-turn runtime does not advertise the
old `run_in_background` switch. External executors without a mailbox keep their
legacy foreground/background behavior; a2a/task tool availability is unchanged.

Each user prompt owns an `AgentMailbox`. Child completion is deduplicated by the
existing job registry and addressed to the launching turn, not whichever turn is
currently running in the same session. A child may also use `send_message` for a
material finding or blocker; its executor is bound to that original parent's
mailbox. It has no arbitrary recipient, interrupt, or root-start capability.
Existing parent-to-child guidance/resume handles remain supported, as do grouped
map/reduce execution, semantic completion assessment, cancellation, report
artifacts, child transcripts, tool restrictions and model tiering.

An async API request makes one routed brain invocation and retains the late-result
fallback below. A sync API request instead owns the root continuations: if the
root returns with registered work or unread evidence, the HTTP layer keeps the
same stream/trace open, consumes that evidence and resumes the root until it can
report. Sync/async controls user-input admission, not child parallelism. See
[request modes](2026-09-16-request-modes.md).

## Model execution boundaries

`wait_agent` waits for mailbox activity, timeout, user steering or cancellation.
It neither consumes the message body nor cancels the child on timeout. The
runtime queues the actual evidence as a hidden `agent_mailbox` custom message,
which pi persists and includes in the next model request. Multiple ready messages
are consumed together. No extra LLM summarizer runs on the notification path.

The sampling wrapper checks completed thinking or explicitly tagged commentary
blocks. When mail is ready and no tool call has been emitted in that sampling,
it clones the completed partial response, cancels only that provider request,
and emits a normal terminal sampling event. Queued mail drives continuation of
the same pi run. It never calls `brain.abort()` for mailbox activity. Avoiding a
cutoff after a tool-call block preserves tool-result pairing and authorized work.

Non-commentary text (including missing phase) defers mailbox delivery; tool
execution and real user steering reopen it. Completed tool turns consume ready
mail before the next model request. Providers without phase annotations do not
get text-boundary preemption, but still get thinking/tool/wait boundaries.

The wrapper sits inside existing recording and output guards so preempted calls
still emit timing/usage evidence and pass through normal sanitation. Provider
usage unavailable because of a cancelled stream is not invented. A routing
checkpoint also records the mailbox consumption cursor: rollback requeues the
discarded attempt's mail in front of later arrivals.

## Late-result fallback

For an async request, when the main brain returns normally, its mailbox is closed. Terminal results
that arrive later, or were deferred behind final text and never consumed, now
enter the session manager's coalesced follow-up queue. Consumed results are not
repeated; intermediate `send_message` updates alone do not start another turn.
Stop/handoff cancels recovery rather than reviving work the user stopped.

The fallback appends one ordinary `role: user` message in the SAME conversation,
tagged `task_notification` as runtime-generated evidence, then runs a new main
turn through normal model routing. The input is saved before calling the model,
even if that call fails. A racing real user turn is allowed to finish first;
the fallback is never steered into it. Single/group completion uses the existing
job deduplication and 600 ms coalescing window. The new turn gets its own mailbox.
This is in-process recovery, not a durable scheduler across restarts.

The main model should still do useful independent work, wait sparingly when
blocked, and integrate required results before finishing when possible.

There is no new message rate limiter. Explicit sends, batched consumption and
safe sampling boundaries constrain interruption, but do not guarantee that a
chatty child cannot cause repeated continuation. This change adds no recursive
subagents or durable scheduler. Legacy detached shell-job notification behavior
outside an owned HTTP turn is unchanged.

## Tool and prompt rollout

`wait_agent` (parent only) and `send_message` (child only) belong to the existing
`spawn_subagents` capability; frontend/backend catalogs must agree. Deploy the
runtime and AgentBox from this revision together. Installations with explicit
raw tool-name whitelists must include the new tools; no whitelist is bypassed.

After runtime tests, delegation guidance is updated to distinguish launch from
completion, allow independent work, require explicit waits on dependencies and
describe the late-result fallback without encouraging premature completion. Platform identity and
safety policy are unchanged.

Verification includes native pi-loop tests (not a replacement loop), mailbox
ownership/dedup/close, commentary and final boundaries, tool continuation, wait
semantics, HTTP lifetime, installed SDK contracts, and normal model routing.
No live provider or production-cluster evaluation is implied by these tests.
