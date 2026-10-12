# Per-Agent engine selection

Engine selection now comes from persisted Agent configuration, not
`SICLAW_AGENT_ENGINE`. SiCore and the standalone Portal backend accept
`agent_engine: pi-agent | codex`; omitted legacy configuration defaults to Pi.
The SiCore Agent create/settings form exposes the selector next to Runtime.

Runtime resolves capabilities and authenticated AgentBox configuration for the
specific Agent. LocalSpawner stores the selection on each SessionManager and
never modifies process-global environment. Prompt payloads cannot override it.
Configuration lookup errors fail closed; Codex never silently falls back to Pi.

An active brain finishes with its original engine. Subsequent cross-engine
continuation is refused with `SESSION_ENGINE_MISMATCH` (409); start a new chat
or restore the former setting. Private engine markers preserve native history
and check Agent/session ownership. This is not cross-engine history migration.

SiCore prevents Pi selection while a published Channel policy is active and
prevents publishing those policies on Pi. Both operations lock the Agent row.
The additive migration preserves Codex for existing active Channel policies.
Other existing native Agents must explicitly select Codex at rollout. Upgrade
SiCore, Runtime and AgentBox together; the old environment switch is ignored.

## Verified implementation checkpoint

- Full Runtime suite: 9,067 passed, zero failures, Node 24.19.0.
- A real Pi SDK brain and pinned source-built Codex brain ran in the same Node
  process. A synthetic Responses endpoint withheld responses until both model
  requests overlapped; each brain then produced its own expected result.
  The deliberately contradictory legacy environment selector had no effect.
- Linux image gates passed: engine coexistence, Channel policy, infrastructure,
  Skill scripts, MCP security, and code mode with MCP and native children.
- Test source delta: `5f916fafa9057e51294f3cdab151ef35138b81e798ed5bccf2d6d99ecaf3a3c0`.
- Runtime image: `13e4966d7e6fa61e6bbb137d9a4e9a3b67eb3250743643f2df0bcdf96af63d57`.
- AgentBox image: `1dd5528c64764a21fd6f96f3a62fef592f112d9d5f735ee123ed7fbcb6bc92fd`.

The deterministic native test uses no production credentials or infrastructure.
Live SiCore UI/model-provider acceptance is recorded separately when completed;
this checkpoint alone does not claim test-cluster deployment or broad model
compatibility. Upstream Codex and deferred memory/output-redaction work are unchanged.
