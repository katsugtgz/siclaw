# Native/Pi security alignment follow-up

Scope: current development branch; no main merge or production change.
Keep upstream Codex, native memory isolation and incremental oversized-output
redaction outside this repair. Group Feishu testing waits for the user.

## Baseline saved

Commit `c038add0` records the previously verified native/Channel implementation
on `feat/pi-codex-agentbox`. Paired SiCore commit is `9668beab3` on
`codex/agent-channel-policy`.

## Real private Feishu acceptance

- R1: `origin=dm`, isolated Agent `79068105-473b-4417-8935-b4f11c16c5b3`,
  Runtime `native-codex-20261006`, published policy r6. Real `cluster_list` and
  `host_list` persisted as successful calls; counts 1/0. Native thread marker
  updated at the same turn's completion. This is real inbound evidence.
- R2 initial attempt: both queries failed opening the grant-local kubeconfig.
  The allowed namespace did **not** pass; the denied namespace was blocked by
  the same precondition. Do not record this as successful namespace enforcement.

## R2 directory repair

Grant caches created every ancestor with mode 0700. Pi's traditional credential
tree permits setgid `kubecred` kubectl to traverse the parent, but the new nested
grant tree did not. Files with group read mode alone cannot overcome that.

Only owned, non-symlink grant ancestors now receive `kubecred` execute-only mode
0710. Ordinary sandbox still has no credential group and no file access; directory
listing is not granted. Local environments without that group remain 0700.
Permission/group application is verified and failure closes execution.

The native Linux smoke now constructs the real `BoxExecutionGrants` hierarchy
instead of only a direct broker. It proves allowed scoped kubectl, cross-namespace
and write denial, no raw credential in the synthetic config, direct sandbox cat
denial, and every grant ancestor's mode/group. No new dependency or group grant.

Verification: 82 focused tests; 8,989 full tests; strict types/build; all eight
Linux native gates passed. Deployed only isolated Runtime generation 43 and its
actually running AgentBox. API and Agent resource policy are unchanged.

- Runtime digest: `sha256:74b93e1e6d9c1611ccad39f655ddf8ff15c037d0ab9c51be5e184b47ec13f9c3`.
- AgentBox digest: `sha256:c6a1e54ed79c0e513526504d2124b436ea0d878c19d117f385394b1ececca9de`.
- Source snapshot: `f7baa014101ff8f6061a480180cb29cfbe048f23b462a0a660cf246d0c30bb66`.

Real R2 re-send at 2026-10-09 02:53:05 UTC completed on the final security image,
but did not pass. Both commands reached Kubernetes discovery and returned HTTP
authentication-required errors, rather than the earlier local file permission
error. The allowed query returned no Pod data; the denied query did not reach a
demonstrated namespace-policy rejection. Do not record either as positive policy
acceptance or infer a namespace bypass from discovery authentication failure.

The bound credential is `Native Codex namespace reader 2026-10-06`, last updated
2026-10-07 10:03:17 UTC. Its normal management API exposes metadata only, not
authentication material or expiration. The existing ServiceAccount and binding
remain present; its namespace Role permits only Pod get/list/watch. Expiration
is a hypothesis, not a verified cause. No credential, Role or binding was
changed, and no Secret was read during this diagnostic pass. Real target
acceptance remains blocked on restoring valid test authentication and retrying.
Protocol fixtures are not a substitute for it.

At 2026-10-09 03:37:22 UTC, following explicit user authorization, the existing
reader credential was updated through the normal encrypted SiCore API with a
new 1,800-second ServiceAccount token (expires 04:07:21 UTC). The existing
ServiceAccount, Pod get/list/watch Role, RoleBinding, Agent resource bindings
and published policy r6 were unchanged. Only public cluster CA material was
projected from the operator config; its admin identity was not transferred.
Before storage, direct requests using the new reader token returned 200 for
`sicore-test` Pod list and 403 for the exact nonexistent `default` test Pod.
This establishes new credential validity and target RBAC, not successful
Feishu/native namespace-proxy acceptance. The old credential's expiration was
not independently confirmed.

The human-triggered R2 retry at 2026-10-09 03:45:33 UTC passed. In the same
`origin=dm` session under published policy r6, native `exec_command` queried
`sicore-test` Pod names/status successfully (nine Pods, all Running). The exact
`default/codex-policy-probe-nonexistent` query returned `Forbidden: Scoped
Kubernetes operation denied`, the broker proxy's static refusal, rather than
upstream authentication failure or NotFound. Both persisted tool results share
trace `f8373da6acb8201f9f9d68d639630115`; the final answer includes
`FEISHU_DM_POLICY_R2`. The existing native thread's last-turn marker advanced
and its rollout remained present at completion (03:45:52 UTC). This is real
Feishu-to-native-to-cluster positive/negative namespace evidence, not fixture
or operator-only evidence. No Secret read or production write was requested.

## Real group Feishu acceptance

Two group Pod-query turns at 2026-10-09 03:58:52 and 04:00:36 UTC passed under
published r6 / group revision 2. Both use group binding identity
`d8be79b2-01f6-42d7-b759-3f40d95f0fbc` and the same group session
`cdcc6b1b-0f0b-4bee-8719-a70f5906149b`, distinct from the private DM session.
The first message reused `FEISHU_DM_POLICY_R2`; its test marker does not change
its actual group route. The second uses `FEISHU_GROUP_POLICY_R2`. Both persisted
native exec_command positive queries returned nine Running/Ready Pods, and both
exact default test-Pod queries returned the proxy's static scoped refusal.
Traces: `6c1564b77b9b0963ae06f09f257b63ea` and
`65f8f2b243be451fb0648b506e088445`. The group native thread's completion marker
advanced at 04:00:46 UTC with its rollout still present. Current group policy
remains topic, query/logs and sicore-test only.

The initial two turns did not include resource-list R1. The user subsequently
sent `FEISHU_GROUP_POLICY_R1` at 2026-10-09 04:12:47 UTC in the same group
session. Persisted cluster_list and host_list calls succeeded at 04:12:55 UTC
under trace `47de99d83dad35d8df082576480611aa`. The cluster result contains one
entry; the host result explicitly reports no hosts. The final answer reports
1/0 and the requested marker. This is a separate real group R1 acceptance,
not a private-history substitution or a duplicate Pod test. Different-member
admission/equal rights and cross-group scope isolation retain their live gates.
The basic same-sender Topic test is recorded below.

### Topic continuity/isolation probe

The user's pure-conversation probes at 2026-10-09 04:24 UTC used no tools.
Topic A seed and follow-up share session c79a75ed-3982-4d65-9a6e-761c6d3c2551
and native thread 01a11ee7-77f7-7022-a482-5486a7469afb. Its native history contains
the supplied synthetic marker in the first user message and both separate turns.
Topic B uses distinct session 539d4051-01ca-49b9-859a-4c2b962d3cce and native
thread 01a11ee8-21be-78a1-8d26-02129ff4a966, with no A marker in its user history;
it answered UNKNOWN and FEISHU_TOPIC_B_R1. Both retain the same authorized group
binding and current topic policy. Routing/thread separation and this negative
cross-topic observation pass; this is not a universal memory-isolation proof.

The initial positive A recall did not pass: both the persisted answer and the
native assistant response contained only FEISHU_TOPIC_A_R1, omitting the marker.
The omission already exists in the native output, not solely in Feishu rendering.
Do not infer a lost thread from it: the same native thread retains the seed and
follow-up. A focused retry at 2026-10-09 04:29:50 UTC was sent correctly into
the original A session, without resupplying the marker and without tools. Its
answer at 04:29:55 UTC is exactly TOPIC_A_X7Q4. Trace:
`d393bc6b8a225f9a9e118687944a1fc4`. The same A native thread retains this third
turn and matching assistant output, while B remains a distinct thread. The
basic same-sender Topic continuity/isolation case now passes; the initial
omission remains recorded and is not evidence that the history was lost.
No production configuration or deferred native-memory design was changed.

## Shared Pi/native security repairs

Three more issues were first reproduced with failing synthetic regressions:

1. MCP path checks preceded fixed-argument injection. Pi and native now validate
   final effective arguments before authorization/dispatch. Raw/encoded/file-URI
   private paths remain denied, including operator-injected ones; zero upstream
   calls are asserted.
2. MCP argv secret sources omitted some echoed fragments: Bearer/Basic bodies,
   URL credentials/query values and absolute-looking password operands. The
   shared live source now registers these values before discovery/model output.
3. Safe env prefixes bypassed sensitive suffixes: NODE_AUTH_TOKEN,
   NPM_CONFIG_PASSWORD, HOME_API_KEY and related canaries survived. Sensitive
   names/suffixes now take priority; normal runtime/cache/locale vars still work.

Final verification: 65 focused tests, 8,995 full tests, strict types/build and all
eight Linux native gates passed. Only isolated Runtime generation 44/AgentBox
were updated. API, published policy r6 and production are unchanged.

- Runtime: `sha256:d93ef8bf82f8c185a530428b5f8eda788f0cf5b1dc56e20709a10ffe38e4a98e`.
- AgentBox: `sha256:020a158eb19e624a54f341be1d4252fdaa52f189c1153629ae29a2c0d4f5cc37`.
- Source: `321b814f5d2684472633c0becfdf18e63df1d63ac7d1def833e50df8c9f0e44f`.

## Alignment scope and retained limits

### Group identity admission follow-up

The real unlinked-colleague screenshot exposed the legacy "DM me to get access"
copy. Its request did not appear in the owned Topic transcript; the transcript
still ended at the previous recall answer. Human refusals are intentionally not
listed in the bot allowlist roster, so an empty blocked-senders list is not
proof of admission. Post-fix real colleague UI/link/continuation still awaits a
human retry and must not be called complete from fixtures.

Published group admission now has a dedicated server path. It never reads or
mutates private access_mode; active identified organization members run under
the common group policy without personal grants. Public/disabled group modes
remain independent. The initial private `/link` implementation was insufficient
and is superseded: the group/Topic now carries one reusable public entry at
`/siclaw/channel-identity/<agentId>`. It contains no sender identity or personal
ticket. Each visitor logs into their own active organization account and
independently verifies their own Feishu identity before authenticated confirmation.
Per-person OAuth state/browser proof/verification handles are never group links.
The compatibility `/link` command returns this same entry. No personal Agent
grant, model session, API key or WebChat link is created, and OAuth tokens are
not retained. Private conversations still enforce their own admission checks;
unpublished legacy paths retain compatibility.

Identity-invite consumption now reads and deletes through the caller's
transaction and rechecks expiry on deletion. Six personal-channel RPCs now
resolve owning Agent metadata before dispatch and enforce Runtime ownership;
foreign probes and an owner cold-start control pass. The remaining legacy group
pair/reset/meta RPCs now resolve their normalized binding/code owner, enforce
Runtime ownership and constrain mutations by the expected Agent. Published
Channel policies reject PAIR. `TestNoUnauthorizedRPCScopeRemains` rejects any
handler retaining the unchecked audit scope. This is not production acceptance
or a guarantee against arbitrary administrative database races.

Verification: 9,002 full Siclaw tests, strict types/build; 3,906 Web tests passed
(three existing skips), strict types and
webpack production build. Linux access/Channel/adapter/identity/ws packages and
real MySQL migration/CAS pass. Two synthetic browser users reused the same public
entry and each confirmed their own identity: two mappings, zero personal grants,
zero production requests. This is not real external OAuth/human acceptance.
Wrong account/browser, replay, revoked policy and identity theft are refused in
service tests. Existing permissions/version-publication guard assertions
were retained and aligned to their already implemented behavior; no security
guard or test was disabled. System Node 25 storage/loopback-test restrictions
are not counted as application regressions; supported Node 24 ran the Web suite.

Only isolated test API/Runtime were updated:
- Runtime generation 46: sha256:5ad2fa40c01089953c1e4c906a186dfaa5e7829095f6f2bf6644116493e32975.
- API generation 20: sha256:6740e8a3af0493d3fa9175ce194a52d5d7d12584f86ddcb7dcea3cd14b624ef3.
- AgentBox remains sha256:020a158eb19e624a54f341be1d4252fdaa52f189c1153629ae29a2c0d4f5cc37.
- API source 2b0d1bd9ecdbe3d5f248e1934f6d3b6ec277b08ab00c1c824e3d74ab04f2c47a;
  Runtime source 7fe8f6dd94722f1fd48cad423b4268e857911a5e798f112367bc5c30646ee247.
- Published policy r6 and group r2/resources/operations were unchanged. Binding
  Web preview remains on loopback 30105; original 30104 is untouched.
  There is no member-reachable HTTPS Web origin/Ingress in this test namespace.
  Loopback origins deliberately produce no shared URL; an administrator setup
  hint replaces private tickets. A reachable HTTPS origin and the App's exact
  OAuth callback allowlist remain required for real colleague acceptance.
  No network exposure was added and no real credentials went to the build host.

Compare Pi/native authorization before dispatch and delivery, production command
whitelists and immutable scripts, namespace/resource limits, raw credential file
and environment access, MCP admission/configuration rotation, owner-scoped secret
sources, streaming/previews/artifacts/history/logging and child/task attribution.
Reproduce issues with synthetic credential canaries before changing shared paths.

### Actionable local identity acceptance correction

The unbound group screenshot verifies refusal, not usability. Four owned group
model histories lacked FEISHU_SHARED_IDENTITY_R1. The missing self-service URL
and DM's group-configuration copy were defects. The user chose local acceptance
on the existing port forward; a new control-plane opt-in is limited to that exact
non-production Agent and exact loopback. Runtime accepts its local URL only with
the trusted boolean flag; wrong-typed flags, remote HTTP and default loopback
remain refused. The API rechecks local eligibility at start/callback/confirmation.

Group/DM cards and the real Web page now give sign-in/verify/confirm/resend steps.
Local cards name the forwarding computer, and DM copy no longer describes group
permissions. DM-only identity linking works independently of group admission.
Real browser entry at 30105 displays the test account and its verification
button; normal API initiation returns 200 with browser proof and the exact
loopback callback. The agent did not perform provider consent or identity binding.
Actual provider allowlist, human confirmation and subsequent Feishu continuation
remain pending; no fixture or negative case substitutes for them.

Verification: 9,009 Runtime tests, 337 focused routing tests, 3,906 Web tests
(three existing skips), strict types/build and OAS generation passed; Linux
services and real MySQL passed. A sandbox-restricted full run hung and was stopped;
the supported Node 24 run with loopback access is the passing evidence.
Final test Runtime digest is 7d6ce34cff1a5febf76ab3a378a83e50aefe78517444dcc4fdcfe1b2aa36ed24,
API digest d6a187ddac5fa32614a1a0529154186d9558cffe9fc7ac7fdff79f3697600b66.
Published policy r6/group r2/AgentBox/resources remain unchanged. The requested
own identity unlink is retained for the user's self-test; no automatic rebind,
network exposure, main merge/push or production change was performed.

| Boundary | Verified implementation/retained gate |
|---|---|
| Cluster | Shared owner broker; shell has no credential group; setgid kubectl uses authorized cache. Scoped native config substitutes loopback HTTPS, keeping upstream auth private. |
| Host/bastion | Node-side ssh2/broker, no model-visible raw config or privileged shell SSH; shared command/path/output validators. |
| Production operations | Shared whitelist and connection-override denial. Channel namespaces additionally close cluster-wide reads, writes and privileged debug. |
| MCP | Exact operator policy, no annotation authority, final arguments validated; native item ownership and before/after Runtime revalidation. Write rules remain unavailable. |
| Output/storage | Live owner secret sources, sanitize before model/previews/artifacts; invalid/oversized/opaque content has no raw fallback. |
| Children/tasks | Frozen audience/original sender and expiring grants; per-holder cache, not later-speaker authority. |

This is not proof that arbitrary approved code is read-only. Fixed reviewed Skill
assets retain Pi's trusted-program boundary; least-privilege target credentials
and asset review are required. Operator-controlled diagnostic helper lifecycle is
not a general workload-write grant. Generic SQL/shell/HTTP MCP tools need backend
enforcement of reviewed arguments; names/effect declarations do not certify code.

No upstream patch, dependency, production-write approval, native-memory redesign
or incremental >8 MiB redaction was added. PTY/unreviewed scripts, unsupported
providers, Cross-Agent handoff and Portal acceptance retain their existing
restrictions/deferred status. Real private R1/R2 and group R1/R2 passed; the other
group gates above remain pending;
do not call the whole deployment production-certified from this review/fixtures.
