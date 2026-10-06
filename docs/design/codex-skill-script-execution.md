# Native Codex Skill script execution

## Contract

Codex uses its existing native `exec_command` / `write_stdin` and exec-server
process lifecycle for Skill scripts. No Pi script ToolDefinition, AgentSession,
interpreter-wide whitelist exception or additional upstream patch is required.

Only the Agent's harness-selected loaded Skill assets may execute. Materialized
bundle governance remains authoritative: production uses published/reviewed
assets; development uses its explicitly selected development snapshot. Native
execution pins the selected Skill package, SKILL.md and script content hashes and rechecks the
session-scoped resolver, builtin disable policy and selected path before launch.
Missing, disabled, replaced and unbound assets fail closed. A changed Skill must
be reloaded into a new approved session snapshot. An approved name is not
permission to execute a different filesystem path or a symlinked script.

Local, Pod, node and SSH script capabilities are independent from ordinary
command capabilities. A script-only Agent does not acquire arbitrary shell,
Kubernetes API or ordinary remote-command access. Native children inherit the
same execution environment boundary; no Pi child executor is involved.

## Native command forms

Read the loaded Skill's SKILL.md for exact filenames and arguments. The script
path below always refers to the approved **AgentBox-local** asset, even for
remote execution. The platform supplies its bytes through trusted remote stdin.

```text
exec_command(environment_id="siclaw", cmd="bash /app/skills/core/<skill>/scripts/query.sh <args>")
exec_command(environment_id="cluster:<bound-name>", cmd="python3 /app/.siclaw/skills/resolved/<skill>/scripts/query.py <args>")
exec_command(environment_id="cluster:<bound-name>", cmd="kubectl -n <ns> exec <pod> -c <container> -- bash <local-skill-script-path> <args>")
exec_command(environment_id="cluster:<bound-name>", cmd="kubectl debug node/<node> -- python3 <local-skill-script-path> <args>")
exec_command(environment_id="siclaw", cmd="ssh <bound-host> -- bash <local-skill-script-path> <args>")
```

The default runtime cap is 180 seconds. An optional `timeout <1-300>` before the
interpreter lowers or raises that cap within 300 seconds; e.g. remote
`ssh <host> -- timeout 240 bash <asset> <args>`. Each call is a literal argv
invocation: no chained commands, redirection, inline interpreter program or
interpreter startup option. Script arguments retain their literal values and
cannot become shell commands. Remote target names, container selection,
credentials, helpers and current broker bindings retain their existing policy.
Environment/identity overrides and interactive stdin remain unavailable.

## Execution and safety

Skill review is the authority for script **contents**; the ad hoc command
whitelist does not inspect every command inside an approved script. This is the
same Siclaw trust boundary as Pi's script execution. Local reviewed scripts run
as the agentbox service identity, with sanitized environment and only the
selected cluster's broker-owned KUBECONFIG (or `/dev/null`). They do not inherit
LLM credentials or arbitrary model-supplied environment. A private bounded
package snapshot preserves local sibling imports and pins main script bytes;
the original Skill remains untouched. Symlink/special-file package entries are
refused. Remote single-file transmission has Pi's existing stdin semantics.

The native exec-server starts a fixed sandbox-side transport client using an
expiring one-use ticket. The service re-authorizes the asset and resource, then
executes the sealed request. The model cannot submit replacement script content
or write to trusted stdin. Complete stdout/stderr are bounded and sanitized
before IPC and native delivery. Oversized output is explicitly suppressed.

Native process termination/client disconnect aborts the service invocation.
Local descendants run in a killable process group. Remote scripts use the shared
setsid/timeout session wrapper and fresh SSH/kubectl cleanup on abort; Pod cleanup
uses the same selected container. Node helpers are operator-controlled, require
an existing namespace and remain pinned until the script ends. They enter host
root/cwd and are released through the existing helper lifecycle.

## Verification gates

Require positive shell/Python execution, exact literal arguments, package-relative
local imports, independent capabilities, denied inline/temporary scripts,
disabled/replaced assets, resource revocation, output sanitization and process
tree Stop. Verify native parent and child behavior through the selected
source-built Codex. Distinguish local component checks, Linux SSH/Pod protocol
fixtures and actual deployed Pod/node/SSH/SiCore evidence. No physical-host or
multi-bastion coverage is inferred from protocol fixtures.
