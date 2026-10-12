# Codex AgentBox compatibility

Siclaw can select Pi or the official source-built Codex in the same AgentBox.
The Runtime/SiCore chat API and event projection remain shared. The native
implementation and acceptance status are maintained in
[codex-native-runtime.md](codex-native-runtime.md).

## Current scope

- Responses models only. An explicit Codex selection never silently invokes Pi.
- Native Codex instructions, tool catalog, planning, compaction, execution,
  filesystem operations and child-agent orchestration.
- Siclaw execution grants, whitelist, broker credentials, OS user isolation,
  output sanitization and existing SiCore events at the native boundary.
- Cross-Agent handoff is intentionally unavailable in Codex mode.
- SiCore UI acceptance comes first; Portal UI is deferred.

The former Pi ToolDefinition MCP bridge has been removed. Codex no longer
requires a Pi AgentSession. Shared session JSONL serialization and resource
selection are still reused by the adapter.

The runtime design's dated records include actual Responses/SiCore/K8sSpawner
acceptance for the native diagnostic path, separately from component/fake-model
checks. Native citation display and MCP errors have [scoped live acceptance](codex-knowledge-citations.md).
Investigation/report/schedule services, structured questions, non-image
attachments and native executor reconnect have [scoped product acceptance](codex-product-compatibility.md#accepted-on-2026-10-07).
The [acceptance matrix](codex-native-runtime.md#remaining-acceptance-work-reconciled-2026-10-07)
distinguishes real named model runs from deterministic provider-failure tests.
Deferred scopes and untested provider/catalog combinations are not a claim of
full Pi feature replacement.
