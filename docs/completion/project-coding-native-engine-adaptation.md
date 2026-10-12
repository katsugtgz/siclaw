# Project Coding Agent Native Engine Adaptation

## Delivered Behavior

The project Coding Agent can use Pi or native Codex while sharing Git query
implementation, CodeView authorization and credential brokering. Codex receives
an intrinsic code service with owned-call checks, bounded paging and cancellation.
It does not execute Pi ToolDefinitions or materialize repository checkouts.

Controlled local commands use the existing command registry. Delivery credentials
are materialized inside the active execution grant and only the private file path
is passed to the CLI. MCP instructions and results use the shared security gate.
Exact operator rules can admit reviewed backend-authorized proposal/result tools;
human confirmation remains with the existing backend. Public proposal tokens are
preserved only at declared JSON paths, with actual credential protection intact.
External MCP metadata follows the existing Pi event envelope for root and child
results.

See [the design](../design/project-coding-native-engine-adaptation.md) and
[the exact DevOps policy example](../examples/project-devops-mcp-policy.json).

## Baselines and Review

This task combines development `f1b3356f` and Siclaw !87 `677028c3`, paired with
SiCore development `dd3167dc0` and !1462 `c32dbf3f9`. These pinned revisions are
integration inputs; they do not include the uncommitted adaptation. Record final
paired revisions before deployment. Future upstream changes may still conflict.

One read-only review found two high-priority defects, both fixed in one round:

- The Runtime HTTP authorization boundary now accepts and validates the declared
  read/write effect before applying the current business authorization rule.
- Execution grants now allocate the delivery credential directory with the
  correct type permissions. Both engines pass the broker's materialized file
  path to the CLI and block model overrides of that path.

## Validation

- Full Siclaw unit suite after production fixes: 461 files, 9,445 tests passed.
- Final test-only refinement: two files, 309 tests passed, including an added
  credential-group traversal case and stronger Pi credential-preparation checks.
- Final TypeScript type check passed. Compilation passed during implementation.
- Paired SiCore: 63 affected Go packages passed, 10,002 test/subtest passes;
  95 MySQL integration cases skipped in short mode. Linux compilation, Web types,
  capability generation/check and five API-reference generator tests passed.
- A broader SiCore repository run was stopped after failures in unchanged
  `internal/admin`, `internal/chatbi` and `internal/platform`. No unrelated
  business changes were made to alter those results.

Development and review are complete. No commit, push or shared deployment was
performed. Actual product acceptance has not run: deploy the paired SiCore,
Runtime and AgentBox to the selected test environment, publish the reviewed MCP
policy, then test ordinary-language Pi/Codex requests, delivery queries, human
proposal cards, A2A and Linux credential isolation there. Local scripted
model/backend flows and consumer parsing probes are not acceptance layers.
