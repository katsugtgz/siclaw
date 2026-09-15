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
refuses private chat dispatch to older runtimes. Deploy Runtime/AgentBox before
enabling Web key issuance in Sicore. This does not grant personal Sicore resource
privileges to an external principal. Capacity planning must include one active pod
per external principal/Agent and persistence storage; configure tenant quotas and
idle release according to the expected number of concurrent users.
