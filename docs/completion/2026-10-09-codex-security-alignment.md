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

Compare Pi/native authorization before dispatch and delivery, production command
whitelists and immutable scripts, namespace/resource limits, raw credential file
and environment access, MCP admission/configuration rotation, owner-scoped secret
sources, streaming/previews/artifacts/history/logging and child/task attribution.
Reproduce issues with synthetic credential canaries before changing shared paths.

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
restrictions/deferred status. Real R2 target authentication repair/retry and group inbound remain pending;
do not call the whole deployment production-certified from this review/fixtures.
