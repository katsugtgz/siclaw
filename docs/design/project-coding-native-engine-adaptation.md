# Project Coding Agents with Native Codex

## Scope and Baselines

This integration preserves project Coding Agent behavior while supporting both
Pi and native Codex. The development baseline is `f1b3356f`; the native Codex
baseline is `677028c3` (GitLab !87). The paired SiCore baselines are `dd3167dc0`
and `c32dbf3f9` (!1462). These dependencies are pinned for reproducible validation.

Agent type and execution engine are separate: `coding` owns the product contract,
while `pi-agent` or `codex` selects the model loop. Existing project authorization
and human confirmation semantics remain authoritative.

## Shared Code Services

Pi and Codex use the same Git query implementation and `CodeView`. Native Codex
receives a concrete `siclaw_code` product service, rather than a bridge that
invokes Pi ToolDefinitions. Git argument validation, mirror access, path
exclusions, immutable commit resolution, limits and cancellation remain shared.

Native code reads, directory listings and searches accept only authorized virtual
`<repo>@<sha>` paths. They do not materialize full checkouts or grant direct access
to bare mirrors. Every operation checks manifest and mounted-repository authority.
Capabilities determine which operations are advertised and callable.

Internal MCP transport authentication is not tool authorization. The service
matches native call ID, server, tool, effective arguments, thread and turn, checks
active root/child ownership before execution and result delivery, and cancels
calls on Stop, turn completion and close. Restricted ticket fills do not expose
unrelated code operations.

## Bounded Results

Git queries retain their 256 KiB business limit. A result truncated at that limit
requires a narrower query; artifact storage cannot recover bytes never produced.
Large available results use the existing Agent/session-scoped artifact store and
a native paging operation. Paging uses character offsets, defaults to 16,000
characters and caps pages at 32,000 characters. Scope, integrity, expiration and
quota checks remain authoritative. Sanitization precedes storage and delivery.
The native code server config sets a finite 64,000-token output limit per
registered code tool. This covers the promised 32,000-character page after UTF-8
and JSON escaping within the pinned Codex MCP serialization margin; external
servers retain their own budgets. Unit cases cover the paging contract. Actual
model-facing delivery is checked after deploying to the selected test environment.

File reads use one-based line offsets and explicit next positions. Lists use
stable ordering and zero-based result offsets. Searches preserve their existing
match and stream limits. Responses distinguish query truncation from transport
paging and never claim a partial result is complete.

## Native Command Preparation

Native commands use the existing context command registry and security pipeline.
Operator extra commands keep their category, contexts, approved executable paths,
flags and credential-free subcommands. They do not gain a second whitelist.

A trusted preparation callback runs after authorization and before spawning a
local command. It calls the existing delivery credential materializer only when
the validated command requires it. Credential-free discovery commands remain
usable without fetching a delivery credential. Preparation failure, cancellation
or revoked authority prevents process launch; authority is rechecked after await.

Each execution grant allocates its own delivery directory before broker
materialization. With credential groups present, opaque ancestors use mode 0711
for traversal without listing; the delivery directory uses `devopscred`, mode
2750, and files remain mode 0640. Local installations without credential groups
keep mode 0700. These rules extend the existing credential-type isolation.

The trusted preparation callback passes the materialized file path through
`SIFORGECTL_CREDENTIAL_FILE`. Pi's restricted command path uses the same helper.
Model-supplied assignments cannot override this path, and grant-bound calls do
not fall back to the shared default file. Token and service-token bytes do not
enter this environment, native filesystem grants, Code Mode, schemas or prompts.
Native children use the same controlled preparation path.

## MCP Instructions and Backend Authorization

Native MCP initialization forwards reviewed server instructions after owner-scoped
secret/path sanitization and a single output budget. Instructions are untrusted
guidance, not permission. Project credential overlays cannot change the server's
URL, command, bindings or operator policy.

The policy retains `effect: read|write`. An exact operator-declared write rule may
set `authorization: backend` for a reviewed backend-controlled tool. This permits
the tool call while leaving business authorization and human confirmation with
the existing backend. Ordinary write rules remain denied. Tool prefixes and MCP
annotations never grant permission. Permits report the actual effect and bind
the current caller, arguments, server configuration and policy before dispatch
and before delivering the result. The Runtime HTTP boundary accepts only the
declared read/write effect values; business authorization verifies them against
the current operator rule.

The project DevOps MCP offers proposal creation and result submission, not
confirmation or execution. Its backend rejects direct project-agent writes and
proposal confirmation. Non-idempotent proposal calls must not be automatically
replayed after cancellation, transport loss or unknown outcomes. Native tool
annotations must retain these semantics rather than relabeling proposals as reads.

Reviewed public workflow strings may be declared using exact `publicResultPaths`
on a backend-authorized rule. For this server, `/items/0/claim_token` identifies
the public one-shot confirmation token needed by the human card. Generic token
heuristics must not destroy it. Known credential literals and their encodings,
private paths and every undeclared sensitive field remain protected. No wildcard
or model-supplied output exception is accepted. The same gate applies to Pi and
Codex before the result reaches model context or stored events.

Configured external MCP results use the Pi-compatible
`details.structuredContent` event envelope, including owned native child messages.
Intrinsic code/knowledge/workflow results retain their product metadata contract.
SiForge's actual live and persisted-history parsers are validation consumers.

The reviewed exact-tool configuration is
[`project-devops-mcp-policy.json`](../examples/project-devops-mcp-policy.json).
Publish it as the registered server's `SICLAW_MCP_OPERATION_POLICY` only after
the paired Runtime and AgentBox versions are deployed. Existing project header
overlays cannot supply this policy. This development does not mutate live MCP
definitions or deploy shared services.

## Validation and Delivery

Unit tests cover bare Git fixtures, capability gates, root/child call ownership,
revocation, paging, credential-free commands, preparation cancellation, MCP
instruction sanitization, exact backend-authorized rules and public metadata.
Compile/type checks and unit tests are followed directly by code review.

Real product testing happens after deployment to the selected test environment:
ordinary-language Pi/Codex requests, actual project data, SiForge confirmation
cards and the intended Linux users/groups. Local scripted model/backend flows and
consumer-only parsing probes do not substitute for this acceptance. Shared
deployment is a separate action. The autonomous development workflow stops before
committing or publishing changes.
