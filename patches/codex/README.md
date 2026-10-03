# Codex source patches

The AgentBox image builds the official [openai/codex](https://github.com/openai/codex)
source at the `CODEX_COMMIT` pinned in `Dockerfile.agentbox`. This directory is
reserved for minimal Siclaw-specific `*.patch` files applied with `git apply`
before the Rust build. There are currently no upstream source changes.

To upgrade, advance `CODEX_COMMIT`, run the AgentBox build, and rebase only
patches that fail `git apply --check`. Keep Siclaw's tool authorization,
session compatibility, and control-plane translation in `src/core/brains/`.
