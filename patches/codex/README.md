# Codex source patches

The AgentBox image builds the official [openai/codex](https://github.com/openai/codex)
source at the `CODEX_COMMIT` pinned in `Dockerfile.agentbox`. This directory is
reserved for minimal Siclaw-specific `*.patch` files applied with `git apply`
before the Rust build.

`0001-gate-apply-patch-with-shell-tool.patch` prevents Codex from offering its
native `apply_patch` when `features.shell_tool=false`. Siclaw keeps that feature
off because native execution does not pass through its sandbox-user command
whitelist or scoped file-tool checks. Codex still owns its plan, compaction,
thread, model calls, and MCP tool orchestration; Siclaw's authorized shell and
file tools are exposed through the per-session MCP bridge.

To upgrade, advance `CODEX_COMMIT`, run the AgentBox build, and rebase only
patches that fail `git apply --check`. Run the patched upstream
`disabling_shell_tools_disables_command_tools_for_all_environments` test and
the Siclaw Codex smoke test before publishing. Keep Siclaw's tool authorization,
session compatibility, and control-plane translation in `src/core/brains/`.
