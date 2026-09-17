# Private Web execution

Web key holders authenticate their own external users. Sicore derives a stable
`web_<128-bit-principal>` from the key's immutable integration ID and subject.
This principal owns transcripts. It is not a Sicore account and does not inherit
the key creator's personal permissions.

A transcript ID alone cannot isolate users: normal AgentBox replicas share the
Agent's PVC subpath and memory index. Web calls therefore use a private routing
scope encoding the source Agent UUID and external principal. The 256 bits encode
losslessly into 50 lowercase base36 characters, the existing label limit. Private
pods use the shorter `webbox` prefix so their certificate Secret names also fit
Kubernetes' 63-character limit. The namespace is disjoint from public UUID Agent
IDs and decodes after restart without a second mapping database.

The manager uses this scope as its pool identity (one replica per user), including
reapers and replacement spawns. Configuration/persistence resolve against the real
Agent UUID. K8s mounts only `agents/<scope>`, so file tools, temporary files and
memory indexes have separate pod/filesystem boundaries. Configured persistence
retains a user's private memory across cold starts. Local/process execution fails
closed because it cannot provide the required OS boundary.

The certificate CN remains the source Agent for configuration/resource bindings;
its signed OU additionally binds the private user. Runtime callback authorization
requires both Agent and user for transcript reads/writes, credential attribution,
metrics and script sandbox callbacks. Ordinary Agent certificates cannot access
private Web sessions. Browser credentials never become console credentials.

Runtime advertises `webUserIsolation` only with the Kubernetes spawner. Sicore
refuses private chat dispatch to older runtimes. This does not grant personal Sicore resource
privileges to an external principal. Capacity planning must include one active pod
per external principal/Agent and persistence storage; configure tenant quotas and
idle release according to the expected number of concurrent users.

## Paired rollout

For the first feature rollout, deploy Sicore schema/API with its matching Web
image, then the compatible Runtime and AgentBox. Enable integrations for use only
when actual running boxes support both private Web execution and API/A2A request
receipt propagation. Updating the configured AgentBox image does not replace
existing boxes; let active sessions drain before replacing them under the
environment's approved procedure.

Older Runtime/AgentBox versions can serve API/A2A calls without the optional
`apiRequestId`, but those model observations have no Key attribution. Protocol
compatibility alone does not establish complete audit. Verify two keys sharing a
session, subagent attribution, and cross-user Web isolation before acceptance.

Once both capabilities are already deployed, subsequent Sicore-only policy/UI
changes can reuse those Runtime/AgentBox images. No new Helm values or environment
variables are required. The Sicore companion's rollout guide also covers legacy
Feishu personal keys that lack verified holders and must be reissued after upgrade.
