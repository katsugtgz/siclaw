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

## Initial local subscription checkpoint

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

## Complete subscription Web acceptance in sicore-test

The user subsequently authorized temporary subscription credentials in the test
cluster and test-only network changes. Native subscription protocol mapping is
now implemented in `codex-model-provider.ts`; the current local smoke script uses
that normal mapping with an access token in host memory, without the initial
checkpoint's auth link or configuration override. No refresh token was copied.

The existing personal Custom Preview `090af5c5-f8ab-4eb9-8b23-d2a5fdd55602` on
`native-codex-20261006` temporarily used a write-only encrypted developer Provider
and model. Direct connections from the Pod to OpenAI/ChatGPT reset while ordinary
public HTTPS worked. An explicitly authorized disposable CONNECT relay allowed
only `chatgpt.com:443`, authenticated every tunnel and forwarded opaque TLS
through the Kubernetes connection and operator workstation. Tests confirmed
unauthenticated and other-destination CONNECT requests returned 403. This was
acceptance infrastructure, not a production search fallback or proxy feature.

Observed results on 2026-10-11 (Asia/Shanghai):

- Real pinned-Linux Codex search in SiCore completed in about 12 seconds and
  persisted a successful `web_search` row and public Kubernetes source links.
- The native radio-option card appeared, survived a page refresh, and submitting
  **Detailed** resumed the model normally.
- A subsequent prompt, refreshed during generation, returned the previously
  supplied `SUB_CONTEXT_K4` marker and the selected output style.
- Stop during a network-waiting model call restored the composer and server
  status became `stopped`. Completed conversation status was `idle`.
- Transcript persistence had 12 distinct message IDs with no duplicate IDs.
- Exact-token scans found no bearer in that transcript or the bounded logs of
  the validation API/Runtime/AgentBox/relay. The API log check was limited to the
  last 5 MB; this is observed scope, not a claim about all historical logs.
- Full Runtime regression: **9,079 passed**, zero failures. Strict TypeScript
  and 25 focused provider/brain tests passed. Pinned Linux search and existing
  native security/coexistence gates passed again.

Test Runtime generation **53**, Ready 1, image
`6a7bb1d12d8987f5f6a3d708109fe124460991f9537a62e6c5087edc7dfe63f6`;
AgentBox image
`f6daccd06c125cdcfb7efd0d09e7fbcf14d82767c1c267f7b5c72e1a62b78bea`;
source delta `eedda73412d0747cccc704c70d27ca604e0952470df26c9f13107f4bce80ed17`.
Primary accepted session: `45c7ded6-7356-4b0e-9f75-760b08f620e1`.

The Preview's effective model, engine and search settings were restored. Its
normal five-minute idle reclamation policy was retained throughout. The
temporary bearer was cleared before the model/Provider and managed credential
were deleted at 15:46; five relay resources, local tunnel and capability file
were removed by 15:48. Durable history volumes and local subscription login were
preserved. Preview redeployment created ordinary audit/release history; no claim
is made that its immutable release ID was rewound.

The subscription-backed SiCore Web path is accepted for this scope. MaaS's
native search endpoint remains unavailable, and continuing subscription use in
this cluster requires an operator-managed egress path because the disposable
relay was removed. Production was not updated and main was not merged.
