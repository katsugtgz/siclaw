# API request modes

`requestMode: "sync" | "async"` controls admission of user input. The default is
`async`, preserving interactive Web steering. It is independent of HTTP JSON/SSE
selection, provider streaming and concurrent subagent execution.

- A sync input queues; it never steers another request.
- An active sync request is protected: later inputs, including async inputs,
  queue until that request has ended.
- Only async input against an active async request may use the existing steer
  path. A merged input is not a second completed investigation.

## Ownership

SiCore owns admission across API instances using its existing conversation fence
and database-ordered waiting tickets. Each logical request retains its own
subscription identity (`requestId`, the channel's persisted user-message ID),
including while queued. A prior request's terminal cannot close its successor.
The request mode follows every authorized handoff. The local Portal/Runtime
shape uses the shared Runtime session queue and correlated turn envelopes.

AgentBox owns execution, not a second ingress queue. It rejects user steering
against an active sync request with `REQUEST_REQUIRES_QUEUE`; the API must admit
that input as a new request. Native mailbox evidence is not user steering and
still reaches the root at normal execution boundaries.

For sync execution, the original HTTP prompt remains open after an early root
return if owned work/evidence remains. Results already consumed by the root are
not replayed. Unread results resume the root inside the same request, trace and
SSE consumer. `execution_end` appears only after root synthesis or a terminal
failure/cancellation. A stopped/handoff-cancelled owner is not restarted.
Async execution retains its original mailbox and late-result follow-up behavior.

## Feishu

Feishu requests sync admission and renders the request stream into one card.
Child events are progress, not independent answers. The channel does not listen
to a second child/session feed or synthesize a second reply card. Its native
Feishu event WebSocket still has its own start/stop lifetime; provider requests
and user-request completion do not close it.

## Rollout and boundaries

Deploy paired SiCore/Runtime/AgentBox changes. SiCore advertises request modes,
Runtime implements `chat.capabilities`, and AgentBox health advertises execution
support. Sync dispatch fails explicitly against an unsupported component.
Existing credentials, bindings and authorization remain authoritative; no new
configuration or production dependency is introduced.

SiCore's waiting-ticket deadline is 30 minutes and does not release an active
execution claim. Tickets serialize admission across replicas; they are not a
durable worker that replays lost in-memory requests after an API process crash.
Local Runtime queues remain process-local. SSE disconnection is not successful
completion. Real Feishu acceptance remains separate from Web and mock-SDK tests.
