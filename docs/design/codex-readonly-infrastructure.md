# Codex read-only infrastructure execution

## Native boundary

Use native `exec_command` and `write_stdin`, including native child calls. The
official source-built exec-server owns process start, polling and termination.
No Pi ToolDefinition/AgentSession or host_exec/node_exec/pod_exec tool bridge is
installed in Codex. Existing credential, SSH and diagnostic Job services are
transport infrastructure and remain independent from the agent engine.

- `cluster:<bound name>`: native read-only kubectl API queries.
- The same environment supports authorized `kubectl -n <ns> exec <pod>
  [-c <container>] -- <readonly command>` and `kubectl debug node/<node> --
  <readonly command>` syntax. Namespace/container flag ordering is accepted.
- `siclaw`: `ssh <bound host name or id> -- <readonly command>`. A shared
  transport avoids one native runtime per host. Broker-owned bastions and
  authentication are resolved internally. The model cannot supply SSH options,
  identities, credentials or forwarding.

## Authorization

Capability booleans come from the current Agent harness. API, node, Pod and SSH
access are independent grants. Native process requests cannot overwrite broker
environment, select another kubeconfig/context/identity, provide interactive
input, choose a diagnostic image or create arbitrary remote filesystem writes.
Remote commands pass a dedicated read-only command allow-list, shared semantic
flag validation and sensitive-path checks. Active benchmarks are excluded.

Each launch refreshes the current bound inventory and acquires current
credentials. Removed targets fail closed. Pod/node GET authorization selects
the exact named target before remote execution. Kubernetes RBAC remains
authoritative; granting Pod exec requires the transport subresource permission,
even though the executed command is read-only.

## Transport and isolation

Validated remote commands become one-use, expiring tickets on a loopback-only
service. The native exec-server launches a fixed transport client under the
existing sandbox UID. The service owns credentials and executes the sealed
operation. Ticket holders cannot alter the operation. Output is buffered,
bounded and sanitized before IPC and again before native model/UI delivery.

Target commands have a 60-second remote timeout with a termination grace period;
transport cancellation is propagated. Node diagnostics use the existing
platform-owned diagnostic Job lifecycle, image and namespace, with existing
deadline/cache cleanup. Creating a diagnostic helper is a controlled platform
operation; it does not grant model-authored Kubernetes mutations or host writes.

Read-only command control does not change the remote account's OS privileges.
Use appropriately scoped SSH accounts and Kubernetes credentials. Unsupported
native filesystem or interactive contracts must fail closed.

## Acceptance

Require native source-built positive reads and negative writes for all four
targets, current broker/SiCore bindings, removed-target denial, sensitive output
redaction and cold child continuation. Separate SSH protocol fixtures from
actual deployed SSH/Pod/node evidence. Test Kubernetes changes remain in the
authorized `roce-test` / `sicore-test` environment.
