# Extra Command Whitelist (Deployment-Configurable)

> Historical design note: terminal UI references describe the implementation at the time. Siclaw removed the interactive TUI on 2026-09-10; see [ADR-020](decisions.md#adr-020-use-web-ui-for-interactive-work-retain-headless-cli-execution) for the current entry points.

**Status**: Approved design, 2026-06-10
**Related**: `docs/design/security.md` §4, `docs/design/command-whitelist.md`, `docs/design/tools.md` §6

## Motivation

The command whitelist (`COMMANDS` in `src/tools/infra/command-sets.ts`) is compiled into
the binary. Deployments that need additional diagnostic binaries (site-specific vendor
tools, extra perftest utilities, …) currently require a source change and a release.
This design adds a **deployment-scoped, additive-only** extension mechanism: a JSON file
loaded at agent startup and merged into the built-in registry.

## Contract (what must hold)

1. **Additive-only.** An extra entry can never replace or relax a built-in `COMMANDS`
   entry. On name collision the built-in definition wins and the extra entry is skipped
   with a warning. This preserves the second defense layer (per-command flag/subcommand
   validation) — a config file must not be able to widen `curl`, `find`, etc.
2. **Declarative constraints only.** The JSON schema supports `category` plus the five
   declarative `CommandDef` constraint fields (`allowedFlags`, `blockedFlags`,
   `allowedSubcommands`, `positionals`, `requiredFlags`). Custom `validate` functions are
   not expressible in JSON — by design, configuration cannot inject code.
   Optional `executablePaths` metadata lists reviewed vendor binary locations
   for native transports. Each path must be canonical, under `/usr` or `/opt`,
   and have exactly the configured command's basename. It does not relax command
   arguments or permit a different binary. Standard system directories remain
   available; arbitrary temporary paths remain rejected by native transports.
3. **Forbidden names.** Binaries the built-in whitelist excludes *on purpose* cannot be
   re-added via configuration: shells/interpreters (`bash`, `python3`, …), multi-call
   wrappers that bundle a shell (`busybox`, `toybox`), Turing-complete text tools (`sed`,
   `awk`, `bc`), exfiltration tools (`nc`, `wget`, `socat`), privilege escapes (`sudo`,
   `nsenter`), argument-executing wrappers (`xargs`, `timeout`, `watch`, … — these would
   bypass first-binary validation), remote exec (`ssh`, `scp`, `rsync`), and `kubectl` (it
   has dedicated subcommand validation outside `COMMANDS`). Two guards enforce this: an
   exact denylist (`FORBIDDEN_EXTRA_COMMANDS`) and a pattern that rejects version-suffixed
   interpreter variants (`python3.11`, `node22`, `perl5.36`, … — common in real PATHs and
   equally code-executing). Both are curated foot-gun guards, not exhaustive; violations
   fail loud at load time. Keep them aligned with the exclusions in `security.md` §4 and
   the `DANGER_PATTERNS` in `src/gateway/skills/script-evaluator.ts`.
4. **Fail-loud on bad config.** A file that exists but fails schema validation aborts
   agent creation with a descriptive error. If `SICLAW_EXTRA_COMMANDS_FILE` is set
   explicitly, a missing file is also an error. Only the *default* path being absent is
   a silent no-op.
5. **Single merge point.** Extras are stored alongside (never inside) the frozen built-in
   registry; every lookup consults built-in first, then extras. The per-context allowed-set
   cache is invalidated when extras are (re)registered. Pi's restricted-bash,
   pod-exec, node-exec and host-exec tools and Codex's native executor automatically
   see the same merged view because they all resolve through `validateCommand()`
   → command-sets. An engine adapter must not shadow this registry with a second
   command-name allow-list.
6. **All other defense layers unchanged.** Extra commands still run as the `sandbox` OS
   user, still pass shell-operator validation, sensitive-path checks, and output
   sanitization. `category` placement controls context availability via the existing
   `CONTEXT_POLICIES` (e.g. a `file`-category extra is unavailable in `local` context).
7. **Audit trail.** The loader logs the resolved file path and the full list of accepted
   and skipped command names once at startup.

## Config file schema

```json
{
  "version": 1,
  "commands": {
    "iperf3": {
      "category": "network",
      "description": "optional free-text rationale (ignored by the engine)",
      "allowedFlags": ["-c", "-s", "-p", "-t", "--json"]
    }
  }
}
```

Validation rules (violations throw):

- `version` must be `1`.
- Command names must match `^[a-z0-9][a-z0-9._+-]*$` (lookup lowercases binary names).
- `category` must be one of the existing `CommandCategory` values.
- Only `category`, `description`, and the five declarative constraint fields are
  accepted, plus optional `executablePaths`; unknown keys (including `validate`)
  are rejected. `executablePaths` must be a non-empty list of canonical absolute
  paths under `/usr` or `/opt` with the entry's own command basename.
- Flags must be non-empty strings starting with `-`; `positionals` must be
  `"allow" | "block" |` a non-negative integer; `allowedSubcommands` must be
  `{ position: <non-negative int>, allowed: <non-empty string[]> }`.

A bare entry (`{"category": "network"}`) means *no flag restrictions* for that binary —
that responsibility lies with the config author; the startup audit log makes it visible.

## Loading & precedence

Resolution order at agent startup (`createSiclawSession` in `src/core/agent-factory.ts`,
memoized — load happens once per process):

1. `SICLAW_EXTRA_COMMANDS_FILE` env var, if set → file is mandatory.
2. Default path `/etc/siclaw/extra-commands.json` → loaded if present, no-op if absent.

This covers every runtime mode through one chokepoint: TUI and `siclaw local` set the
env var if they want extras; the AgentBox image bakes a file at the default path.

## Distribution

- **Build-time bake (K8s mode)**: `docker/extra-commands.json` is copied to
  `/etc/siclaw/extra-commands.json` in `Dockerfile.agentbox`, so it carries the
  deployment's site-specific binaries into the image. The COPY destination and the
  loader's default path are the same string in two files, and a mismatch is SILENT —
  an absent default path is a no-op, not an error, so the commands simply stop being
  whitelisted. `extra-commands.test.ts` asserts the two agree, loads the real file,
  and checks each declared command reaches the node/host contexts.
- A deployment that layers this repo (rsync-style overlay, ConfigMap, fork) replaces
  the file wholesale rather than merging, so the same binary declared in two layers
  keeps only the outermost declaration. Whichever layer wins must carry the complete
  set — a command dropped there is not refused loudly, it is just absent.
- **Runtime override (future, not in scope)**: mounting a ConfigMap over
  `/etc/siclaw/extra-commands.json` in the AgentBox pod spec would avoid rebuilds; this
  needs k8s-spawner pod-spec changes and is deliberately deferred.

## Security analysis

- Threat model: whoever can write the config file or set the env var already controls
  the image / pod spec / local process — no new trust boundary is crossed.
- The mechanism can only *add* binaries; it cannot remove or alter restrictions on
  built-in commands, kubectl subcommand validation, shell-operator rules, or sensitive
  path patterns.
- Cross-reference `src/gateway/skills/script-evaluator.ts` (DANGER_PATTERNS) is
  unaffected: it evaluates skill scripts, not the exec whitelist.

## Testing

- Schema validation unit tests (every rejection rule, plus a maximal valid config).
- Merge semantics: built-in collision skipped + warned; cache invalidation observable
  through `getContextAllowedSet`; category placement respects `CONTEXT_POLICIES`.
- End-to-end through `validateCommand()`: an extra binary passes in the right context,
  is rejected in a context whose policy excludes its category, and its declarative
  constraints are enforced.
- Loader: env-var-mandatory vs default-path-optional behavior; fail-loud on invalid file.

## Documentation impact

- `docs/design/command-whitelist.md`: new "Deployment extras" section.
- `CLAUDE.md` Change Impact Matrix: row for `src/tools/infra/extra-commands.ts`.
