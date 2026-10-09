# Versioned Channel execution authority

The SiCore product specification is
`docs/design/2026-10-09-siclaw-channel-permissions.md` in the SiCore repository.
This is the Siclaw enforcement contract, not an upstream Codex patch.

## Authority chain

```text
App / exact chat route -> admission + configured group snapshot (SiCore)
  -> channel.policy.resolve with original session, actor and sender
  -> Runtime frozen grant: resources + version/revision/fingerprint + constraints
  -> AgentBox scoped broker and native executor / MCP authorization
  -> target's actual permissions
```

All admitted senders in a group share its execution rights. The original sender
is immutable audit/admission provenance, never a source of personal group rights.
DM member rights additionally intersect their own resource scope. Public users
get only explicitly selected policy resources; no creator fallback.

## Shared group identity entry

Published groups never use private `access_mode` for admission. An identified
group shares `/siclaw/channel-identity/<agentId>` with all members; this reusable
URL contains no person or proof. Each person signs in and independently verifies
their own provider identity before confirming the mapping. Binding does not
create personal Agent/infra grants. The optional legacy `/link` command returns
the same entry; it is not a group prerequisite. Missing reachable HTTPS frontend
configuration produces an administrator setup hint, not a private ticket or
loopback link. Real external OAuth acceptance is a separate deployment gate.

For the explicitly requested local acceptance, the control plane can opt in one
exact non-production Agent to the operator's loopback origin. Start/callback/
confirmation recheck that setting and current production status. The trusted
RPC boolean permits only exact loopback in Runtime URL validation, never remote
HTTP; absence or wrong-typed values fail closed. The card names the forwarding
computer and gives direct sign-in/verify/confirm/resend instructions. DM copy
does not describe group permissions. This is not external-member acceptance.

## Native boundary

- Native JS orchestrates atomic capabilities. It cannot receive raw Kubernetes,
  SSH or MCP authentication material. Existing command whitelist, private path
  grants, output sanitization and Linux sandbox UID separation remain in force.
- A scoped kubeconfig names a broker-owned loopback HTTPS server and an opaque
  per-grant token. The certificate is generated ephemerally; its private key and
  real upstream authentication remain in the trusted Node process. Explicit CA
  data is supplied to kubectl; upstream TLS is unchanged.
- The API proxy independently checks namespace, method, resource and operation.
  No cluster-wide/all-namespace reads, Secret/service-account authority, writes,
  PTY/interactive shell or arbitrary native script admission is introduced.
- Native platform Pod wrappers get exact target/container/argv permits. Script
  assets are already immutable/approved. Cancellation/revoke only runs the
  generated cleanup for that wrapper's owned process group.
- Scoped MCP calls require selected server ID, exact operation, mandatory finite
  argument filters, current policy fingerprint and the existing read-only MCP
  effect policy. Configuration credentials stay in the private gateway.
- Knowledge gets a manifest-selected, process-owned view/resolver with citation
  sidecars. No whole-Agent resolver or legacy repository overview is injected.
- Scoped grants require new Runtime/box declarations. Unsupported Pi/model
  execution fails closed; legacy non-opted-in sessions keep their old behavior.

## Revocation and persistence

Authority is checked before new production operations and on renewal. Changed
fingerprints revoke old holders. Runtime invalidation pushes cancellation; the
lease deadline remains the fallback when a notification is lost. An in-flight
remote operation is not a promise of instantaneous cross-network termination.

Children retain their parent's audience and original sender. Scheduled tasks
persist source Channel session/sender on the control plane; a fresh task session
must resolve that provenance. Unknown/foreign Channel provenance cannot fall
back to a creator-authorized Web session. Retained history is not reclassified.

Native memory isolation and the >8 MiB incremental structural-redaction design
remain explicitly deferred. Existing memory behavior and output suppression
gates are not weakened by this contract.

## Acceptance

Final source: 8,987 Siclaw tests passed, strict types/build passed. Real pinned
Linux app-server/exec-server tests covered UID 1001 process cancellation, native
children, stream delivery, resume, script/MCP controls and scoped kubectl with
credential canaries, namespace/write/file-read denial and revocation. Those
API/model/SSH/Pod fixtures are protocol evidence, not real target evidence.

The matching SiCore source passed real MySQL migration/CAS and Linux suites,
363 focused Web tests, strict types, production build and real native Web
question refresh/structured answer/Stop recovery. Final isolated deployments and
the actually spawned AgentBox were digest-verified. No main/production update.

New-policy inbound Feishu and live Channel-grant target acceptance remain the
human/integration follow-up recorded in SiCore's completion evidence.
