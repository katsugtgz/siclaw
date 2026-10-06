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
The native node path requires an already provisioned namespace and never creates
a namespace. An explicit operator `SICLAW_DEBUG_IMAGE` pin takes precedence over
the bound cluster's diagnostic image and the default image. The model cannot
override either. Node commands enter the host's root and cwd as well as its
mount/UTS/IPC/network/PID namespaces.

Codex prompt assembly omits Pi infrastructure tool-name guidance while keeping
the same SRE capability grants and operational safety. Native environments and
SSH syntax are supplied as application instructions alongside Codex's own base
instructions. `src/core/prompt.ts` is unchanged.

Read-only command control does not change the remote account's OS privileges.
Use appropriately scoped SSH accounts and Kubernetes credentials. Unsupported
native filesystem or interactive contracts must fail closed.

## Acceptance

Require native source-built positive reads and negative writes for all four
targets, current broker/SiCore bindings, removed-target denial, sensitive output
redaction and cold child continuation. Separate SSH protocol fixtures from
actual deployed SSH/Pod/node evidence. Test Kubernetes changes remain in the
authorized `roce-test` / `sicore-test` environment.

### Actual test-cluster evidence (2026-10-06)

Source `473677a5` passes 411 test files / 8089 tests, TypeScript and build. The
official source-built exec-server with a real SSH protocol fixture verifies
broker-owned authentication, read-only rejection, removed binding denial and
sanitization before private IPC.

The independent Runtime uses `codex-infra-test-473677a5` (digest
`sha256:2e086b545f06290bf9ba9e9230b68c979f56b4a088a1c9aac770e64dcf31093f`).
This test-only image fixes helper namespace `sicore-test`, an internal reviewed
debug image, a 120-second helper deadline and five-second idle cleanup. The normal
production image keeps operator configuration. Codex's pinned GitLab source
commit is unchanged; these changes do not require another upstream patch.

Actual SiCore API, broker, Responses model and K8sSpawner produce 11 persisted
native command rows: six successful reads and five refusals. Reads include Pod
JSON, Pod kernel, node hostname `nodepool-062`, the node's Ubuntu 22.04.4 host
`/etc/os-release`, SSH UID `2001` and the SSH kernel. Refusals include API Pod
delete, Pod file creation, node sysctl writes, SSH file creation and an unbound
SSH host. The SSH target is an isolated real OpenSSH Pod with a readonly account
and readonly root filesystem; this is not a claim of physical-host SSH or
multi-bastion deployment acceptance. Existing SSH chain services/tests are reused.

The native V1 child performs the same broker SSH and Pod reads and receives a
pre-execution write refusal. Its actual child transcript has two successful tool
rows and one refusal. After deleting/recreating only the test AgentBox, the Pod
UID changes and native thread ID remains the same; SSH/Pod reads and write
refusal still pass. No Pi execution session participates in either check.
Revoking the actual SiCore SSH binding then makes the same native conversation
refuse further access. The cluster binding remains unchanged. All attempted
write-marker files are absent on the fixture target.

The user explicitly approved temporary Pod exec/helper Job permissions and
read access only to the selected node. Do not retain the temporary permission
expansion or SSH fixture after acceptance. Raw keys, tokens and transcripts live
only in the private validation directory, never in this repository.
After acceptance, the test reader's namespace Role is restored to Pod
get/list/watch only, its temporary node ClusterRole/Binding is removed, and the
SSH Pod/Service/public-key ConfigMap plus the private SiCore host/credential are
removed. Diagnostic Jobs/Pods finish cleanup; the existing Runtime and PVC remain.
