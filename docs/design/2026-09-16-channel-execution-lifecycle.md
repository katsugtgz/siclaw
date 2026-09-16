# Independent execution and channel lifetimes

Provider sampling, an AgentBox prompt execution, and an IM connection are three
different lifetimes. A sampling cutoff/retry must neither close the Feishu event
WebSocket nor finalize the current reply card as a successful answer.

## Execution contract

AgentBox now emits a runtime-authored `execution_end` data event before normally
closing `/api/stream/:sessionId`. Its `outcome` is `completed`, `error`, or
`aborted`; `unknown` means no confirmed outcome is available. It is emitted only
after the entire prompt finishes, including model routing and mailbox-driven
continuations. A late subscriber receives the same outcome after replay.

This is deliberately NOT `prompt_done`: the control plane already owns that
public event after persistence/handoff. Emitting it prematurely from the box
could close the Web client before those operations finish.

The channel execution adapter consumes raw AgentBox events until `execution_end`,
or control-plane conversation events until `prompt_done`/`done`. Provider
message/turn/agent end events and subagent completion are ordinary execution
events, never channel termination. Retry errors can recover; a `stream_error`
is not by itself a transport-close instruction.

An EOF or exception before the authoritative terminal event is incomplete
delivery, not success. The adapter rejects it instead of returning the latest
progress paragraph as the answer. Lark renders a sanitized delivery-error or
cancellation notice, without positive-answer feedback controls. The shared
DingTalk collector follows the same execution contract.

## Feishu transport and rendering

`createLarkHandler` owns the event WebSocket independently. Message callbacks
ACK immediately and dispatch work separately. Card callbacks retain their own
short response path. Only explicit channel stop/reload closes that connection;
neither provider cancellation nor a failed task calls it.

The card receives progress while the execution is active. A confirmed completion
authorizes its final answer; failure authorizes an error notice instead. The
existing card sequence/coalescing and fallback-delivery behavior remain intact.

Feishu submits `requestMode: sync` and consumes one request stream through owned
background work and the root's final synthesis. It does not subscribe separately
to child completion or background-turn lifecycle, nor open a second result card.
The previous detached-turn channel listener and answer-length heuristic have
been removed. Detached assistant rows are not allowed to replace the request's
card; explicit `channel_update` delivery remains available.

## Compatibility and checks

Deploy Runtime and AgentBox together: a new strict IM collector intentionally
does not treat an older box's unmarked EOF as success. Request modes additionally
require the matching SiCore admission schema/protocol; capability negotiation
rejects unsupported sync requests instead of silently using async behavior.
There is no new dependency or provider API change, and no change to the provider's
sampling cutoff policy or Feishu subscription settings.

Regression checks cover early agent_end, child completion, provider recovery,
terminal failure/cancellation, premature EOF, late SSE subscription, and a mocked
Feishu WebSocket kept alive across both continued execution and failed delivery.
The latter is a deterministic adapter test, not evidence that a real Feishu event
subscription, card permission, or callback is configured correctly. Real IM
acceptance remains a separate, user-triggered case.
