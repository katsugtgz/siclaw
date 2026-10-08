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

Real R2 re-send remains pending. Protocol fixtures are not a substitute for it.

## Security audit in progress

Compare Pi/native authorization before dispatch and delivery, production command
whitelists and immutable scripts, namespace/resource limits, raw credential file
and environment access, MCP admission/configuration rotation, owner-scoped secret
sources, streaming/previews/artifacts/history/logging and child/task attribution.
Reproduce issues with synthetic credential canaries before changing shared paths.
