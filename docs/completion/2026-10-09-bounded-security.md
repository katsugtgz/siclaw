# Bounded grant renewal and native MCP capability alignment

Scope: existing development branches and isolated `sicore-test` validation only.
No main push/merge, new target authority, production write, core prompt change,
dependency/SDK upgrade or upstream Codex patch. Native memory isolation,
incremental oversized-output redaction and production write approval remain
deferred. No previously removed disposable acceptance Agent is recreated.

## Reproductions and repairs

Before repair, thirteen added regressions failed: eleven lease checks and two
MCP capability checks. The compiled lease parser accepted `3600000` as one hour
and accepted unsafe integers. Runtime injected options and AgentBox wire values
could also exceed the intended 60-second revocation bound.

- The shared parser accepts only safe whole milliseconds, caps longer valid
  values at 60,000, and preserves valid shorter leases. Invalid input uses the
  existing safe default. Runtime injection cannot bypass normalization.
- AgentBox refuses invalid/oversized wire leases before materializing credentials.
  Invalid renewal never extends an old holder. Deadline expiry still cancels its
  owned parent/child callbacks during control-plane loss or a hung renewal.
- Native MCP exposes only tools. Resource/prompt-only configuration no longer
  starts/authenticates an upstream server. Unsupported capabilities are absent
  from initialization, and six forced resource/prompt requests return the SDK's
  local MethodNotFound without authorization/upstream dispatch.
- Existing reviewed tools, operation scopes, before/after authorization and
  embedded-text result redaction remain active. Pi uses its unchanged shared
  policy/manager. Existing safety tests are retained, not disabled.

The previous resource/prompt success test used a permissive authorization stub,
not the real owned-native-item authorizer. It now asserts the real supported
boundary; upstream resource/prompt handlers also increment the fixture counter
to independently detect any accidental dispatch. A permitted read still runs
and authorizes twice after the six refused requests.

## Validation

- **73 targeted tests** passed in five files after failed-before reproduction.
- Final bounded-security checkpoint: **9,058 full tests** passed on supported bundled Node 24.19.0; 206 local focused and 89 Linux focused tests also passed.
- TypeScript typecheck, build and whitespace checks passed.
- Six Linux/pinned-native gates passed. The isolated validation Runtime reached
  generation 49, Ready 1, with Runtime digest `a36c6490d13e505dfd206544eae1500a8ffbff6a2330e557f62955336e63fddf`
  and AgentBox digest `e9d1ac0977a8f6853b9ca579def4b35855df5eace12156c18b8214e69bf6609c`.
  Source delta: `83644ea48c3aec0cdc35bc23d1bc81a9187a3d98eede7496e742030ec616db7b`.

Tests cover missing/malformed/fractional/unsafe configuration, valid shortened
leases, hour-long overrides, wire limits, no-push/unreachable control plane,
hung renewal, deadline cancellation, absent MCP capabilities, no connection for
unsupported-only configuration, six forced protocol methods, zero unauthorized
upstream operations, tool continuity and embedded-output sanitization.
They are contract/security tests, not a new business-tool or broad-model eval.

Both SiCore product languages now state the native tools-only boundary and the
safe operator path for exposing data through reviewed atomic tools. No SiCore
API/schema change is required. MCP capability declarations were checked against
the [resource specification](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
and [prompt specification](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts);
the installed v1.27.1 SDK remains pinned by the existing lockfile.
