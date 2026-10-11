# Native web research: subscription verified, MaaS route blocked

Agent-owned `disabled/cached/live` search configuration is implemented end to
end through SiCore/Portal storage, authenticated Runtime sync, per-manager
selection, native Codex configuration and SiCore tool activity/history. Existing
Agents default to disabled. Shell networking and production grants are unchanged.

## Verified

- Runtime full suite: **9,074 passed**, zero failures; strict TypeScript passed.
- SiCore Agent/adapter/Channel Go suites passed; additive migration passed on
  SQLite and real MySQL, including replay and legacy-disabled behavior.
- API reference generator: 5 tests passed; Web TypeScript and production build
  passed. In-app browser verified the Codex-only selector and saved cached mode.
- Fixed native source `d4684bba`: three search modes for each of `gpt-5.5`,
  `gpt-5.6-luna` and `gpt-6-astra` passed against a synthetic provider (9 cases).
  The latter two exercise native Code Mode `tools.web__run` and `/alpha/search`,
  not an invented hosted tool declaration. Links and search events are preserved.
- Coexistence, Channel policy, infrastructure, Skill scripts, MCP security and
  code-mode/children native gates passed again. No upstream source changes.
- Final test Runtime generation **52**, Ready 1:
  `e426f4e86d89d013dc9062136fd60c47c1aee34eb532926928547c6e079de2f8`.
- AgentBox: `f289ecbbc40fe4e73e886cafc8fbaa4f07b5590ec83448dfc5401b8c97e6bc14`.
- API generation **25**, Ready 1:
  `48816c38aca49d8bc83a9e9f54cbf66da386d35654921697b1aea088c6a67e0d`.
- Runtime source delta: `986b2aabf9e7868d6ee757a4026df094a35da8ed7a4d24d785f1a077522de5f8`;
  API source: `0c465c4541d1d1e1127ddf76887d34bf903c01b02cc751196ae48208037fa01a`.

## Real provider result and next gate

An isolated Web-only Codex Agent with no cluster/host/MCP bindings requested
official public Kubernetes readiness-probe documentation on the existing
`gpt-5.6-luna` MaaS binding. Session
`0ec3a046-b14d-446c-bbc9-e25372442482` emitted actual `web_search` activity, then
the native search service returned **HTTP 404**. The tool row ended as an error;
the assistant reported search unavailable instead of claiming verified sources.

This is **not a successful live search acceptance**. Responses Lite requires the
configured provider's native `/alpha/search` service, which the tested MaaS route
does not currently serve. No silent provider/engine/network fallback was added.
The original Feishu test Agent's search remains disabled pending a supported
provider. Next gate: enable that service on the authorized MaaS route (or choose
an explicitly approved compatible provider), then repeat actual search + source
verification. Synthetic provider success does not establish MaaS availability.

See `docs/design/codex-web-search.md` for query/context egress and the absence of
a pre-search Siclaw DLP hook. No production deployment or main merge occurred.

## Real subscription acceptance (continued at user request)

The user's local native Codex login reports ChatGPT authentication. Installed
`codex-cli 0.162.0-alpha.2` completed a real `gpt-5.6-luna` public Kubernetes
search in an empty read-only workspace, with a native search completion and
official source URL. No token bytes were printed or exported.

`scripts/test/codex-subscription-search-smoke.mjs` then ran the actual compiled
Siclaw `CodexAgentBrain` with the installed native binary and existing local
login. Both **live and cached modes passed**: tool start/end, non-error search,
researched answer and official source link. No infrastructure, shell, filesystem,
MCP or child-agent operation was performed. A mode-0700 temporary native HOME
linked the existing local auth file for native authentication; the test never
read token bytes and removed the owned temporary directory after each run.

This harness overrides only test authentication/provider selection. It does not
add production subscription provisioning, transfer credentials to Shanghai or
Kubernetes, modify the user's normal Codex config, or claim the installed Mac
binary is the fixed Linux source build. The pinned Linux protocol/security gates
above and real local subscription adapter tests are distinct evidence.

The `sicore-test` deployment still uses MaaS; its `/alpha/search` 404 remains.
Subscription success proves the Siclaw/native search path can work with a real
supported service; it does not retroactively pass the MaaS or subscription-backed
SiCore Web deployment gate.
