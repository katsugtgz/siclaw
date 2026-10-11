# Native Channel resource rules

Channel policy v2 preserves the association between each resource scope and its
operations. The broker selects cluster rules before constructing the private
Kubernetes proxy; each request must match one complete namespace/action rule.
SSH authorization uses the canonical host ID returned by SiCore, not a display
name. MCP tool selection and finite argument constraints must match the same
rule. V1 behavior remains supported. New grants require an AgentBox declaration
of resource-rule enforcement; policy fingerprints continue to drive revocation.

Validation: 449 test files / 9,082 tests passed, strict TypeScript passed, and
eight internal Linux native smoke gates passed. The v2 native fixture verifies
that query in one namespace and logs in another do not combine into query
authority in the second namespace. The fixture also covers real upstream native
exec-server execution, private kubeconfig, forbidden file/namespace/write access
and revocation. It is a fixture test, not a production cluster execution.

The isolated sicore-test Runtime is generation 54, image
b467e1411028cd45a5933d09c57bae996491376c4970dd5744d485e6244faba8, selecting
AgentBox f9a7035a0b9593cf0ec557483bd8de54474968b5d7eca9cfe1139630b8da3cc0.
Source archive 2e06787482883408de77023c99f713cc430111d967050507f8ad0d90bf1b300a
was tested and published on the internal Shanghai builder. SiCore's paired
completion record documents API/Web images and live publication checks.

After deployment the existing Codex test Agent completed a real read-only Web
query of roce-test: 5 nodes / 5 Ready. Existing Feishu policy revision 6 was kept;
live Feishu v2 execution and final browser click-through remain separate from
the proven native-fixture and API lifecycle checks. Main and production were
not updated. Deferred native memory isolation, oversized structured output and
production write approval were not changed.
