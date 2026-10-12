# Siclaw Project Instructions

This file is the project-level Codex guide for `siclaw_dp_cleanup`. Keep it
limited to stable Siclaw facts and constraints. General collaboration style
belongs in `~/.codex/AGENTS.md`; `CLAUDE.md` is the larger legacy reference when
deeper background is needed.

## Project Shape

Siclaw is an AI-powered SRE copilot for Kubernetes diagnostics.

One agent core supports three runtime shapes:

```text
Headless CLI: non-interactive diagnostic invocation, optionally paired with local Portal
Gateway + LocalSpawner: local multi-user dev, one process/shared filesystem
Gateway + K8sSpawner: production, one isolated pod per user
```

## Before Risky Edits

- Preserve user changes and unrelated dirty work.
- For security, tool execution, database, Portal snapshot, guards, memory,
  Docker, Helm, or K8s behavior, read the nearby code plus relevant
  `docs/design/*` or `CLAUDE.md` before editing.
- Ask before editing `src/core/prompt.ts`; it affects core agent behavior and
  product tone.
- Do not add production dependencies unless explicitly requested.

## Verification

Use targeted checks first, then broaden when touching shared behavior:

```bash
npm test
npx tsc --noEmit
npm run build
```

Broaden verification for database schema, tool execution, guards, Portal
snapshot, K8s/Docker/Helm, or user-facing workflows.

## Stable Boundaries

- `LocalSpawner` runs all local AgentBox instances in one process with a shared
  filesystem. Local skill sync must stay user-scoped and must not wipe shared
  skill directories such as global/skillset/user trees.
- Core skills are baked into the Docker image. Workspace skill bundles should
  include only selected global/dev/personal skills.
- Headless CLI uses local Portal as a read-only snapshot source. Unscoped
  invocations tolerate unavailable snapshot access; a selected agent must load
  successfully. Snapshot caches are private to each invocation, including empty
  resource sets, and cleanup must never touch another invocation.
- Shell execution security is layered: OS-level isolation first, whitelist-only
  command validation second, plus pre/post execution sanitization.
- MCP tools require the operator-owned exact policy in
  `docs/design/mcp-readonly-security.md`; server annotations grant no authority.
  Sanitize before model delivery, progress previews and artifact persistence.
  Pi and Codex must reuse this policy and the owner-scoped credential sources.
- Portal/Gateway DB and Memory DB are separate persistence domains. Do not mix
  user/session config with embedding/chunk/investigation storage.
- AgentBox and Runtime are separate processes in K8s mode. Code under
  `src/agentbox/**` must not import Gateway or Portal persistence modules such
  as `src/gateway/chat-repo.ts`; LocalSpawner's shared process can hide this.
  AgentBox background work should call Runtime internal APIs through
  `GatewayClient`, with Runtime owning Portal RPC and database persistence.
- `src/portal/migrate.ts` must stay compatible with both MySQL and SQLite.
- mTLS is for K8s mode only; do not pull mTLS requirements into local mode.

## Stack And Local Conventions

```text
Runtime: Node.js >= 22.19.0, ESM-only
Language: TypeScript 5.9 strict, .js imports
Tests: vitest
Frontend: React + Vite + Tailwind
Agent: @mariozechner/pi-coding-agent
Gateway DB: mysql2 / node:sqlite raw SQL
Memory DB: node:sqlite + FTS5 + sqlite-vec
```

- Use named exports; avoid default exports.
- Siclaw is English-first and open-source-oriented. User-facing UI labels,
  prompts, docs, and PR text should default to clear English unless localization
  is explicitly requested.
- Follow `CONTRIBUTING.md` for PR format.

## Branches And Codex Upgrades

- Name work branches by purpose, such as `feat/...`, `fix/...`, or `docs/...`.
  Do not use a `codex/` prefix.
- The GitLab `aiops/codex` repository keeps official `openai/codex` unchanged
  on `upstream/main` (`origin/main` in a clone whose official remote is
  `origin`). Its protected `main` contains the minimal Siclaw patch series.
- Prefer Codex's native capabilities and Siclaw adapter configuration before
  changing Codex source. Use merge requests for normal patch changes.
  Periodically sync the official main branch to `upstream/main`, merge it into
  a `chore/...` branch from GitLab `main`, review and test, then merge through
  a merge request. Never rebase or force push protected `main`, and never add
  Siclaw commits to `upstream/main`.
- The target Codex integration uses its native instructions, tools, execution
  environments, and agent lifecycle. Implement Siclaw-specific policy and
  services at native extension boundaries; do not wrap Pi tool definitions or
  require a Pi AgentSession as the Codex implementation. See
  `docs/design/codex-native-runtime.md` for the replacement direction.
- Pi and Codex share Agent resource selection, Skill/Knowledge materialization,
  MCP configuration and credential brokering. Keep one resource sync/mount
  pipeline; adapters project selected assets into their engine's native APIs.
  Codex Skill scripts use `docs/design/codex-skill-script-execution.md`, never
  a second Skill store or Pi script-tool bridge.
- Validate the Codex runtime with SiCore as the UI first. Portal UI acceptance
  follows only after that runtime path is complete.
- Codex owns its native memory mechanism. Do not adapt Siclaw memory tools,
  indexes, profile prompts, flush hooks or session-summary persistence into
  Codex. Keep native storage private to the owner and selected Skill scope;
  the legacy Siclaw memory switch applies only to Pi sessions.
- `Dockerfile.agentbox` fetches GitLab `main` and verifies the exact
  `CODEX_COMMIT` before building. Advance the pin after reviewing the source
  diff and passing Codex Rust tests/build, the Siclaw app-server smoke test,
  and Siclaw regression tests. Keep the Pi path available for compatibility.
- AgentBox Docker builds need an SSH agent authorized to read `aiops/codex`.
  The host key is pinned in `docker/gitlab-known-hosts`; pass `--ssh default`
  when building directly. Never bake an SSH key or access token into an image.

## Commit Notes

Commit messages should explain why. Add trailers only when they carry useful
context:

```text
Constraint: <external constraint>
Rejected: <alternative> | <reason>
Confidence: <low|medium|high>
Scope-risk: <narrow|moderate|broad>
Directive: <future warning>
Tested: <what was verified>
Not-tested: <known gaps>
```
