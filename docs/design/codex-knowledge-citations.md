# Native Codex knowledge citations and MCP error projection

## Shared knowledge and provenance

Pi and Codex use the same selected knowledge bundle, version-owned citation
manifest, evidence markers, claims, source cap and remount validation.
`knowledge-citation-service.ts` owns these checks without a Pi runtime dependency;
`knowledge-citation-tool.ts` is the small Pi adapter. No second knowledge store,
resource selector, sync handler or compilation format is introduced.

Codex reads through its native shell/filesystem tools. The adapter observes
owned `commandExecution` items, captures the selected Markdown bytes and mount
receipt before execution, and registers a read only after a successful result
whose complete sanitized output matches that snapshot. Plain `cat`, `head` and
`tail` are eligible; partial/truncated, transformed, failed, script/remote,
symlink, out-of-mount and changed-content reads are not full-page provenance.
Searches can locate evidence but do not themselves establish a full-page read.
Captured pages are bounded at 512 KiB and 8 MiB per active turn. These are
provenance bounds; ordinary command output still uses native Codex budgets.

## Native citation service

The single reviewed product operation is `knowledge_cite`, registered in the
native MCP server `siclaw_knowledge`. It calls the shared validator directly;
there is no Pi ToolDefinition/AgentSession bridge. Native discovery, schemas,
tool search, invocation and history remain owned by Codex. This MCP boundary
also works for existing native thread resume, whose pinned protocol cannot
append `thread/start.dynamicTools` during `thread/resume`.

The authenticated loopback gateway consumes native tracing metadata. It retains
only native `callId` locally, matches it to an owned active app-server tool item
and turn, and never accepts a model-supplied thread/read receipt. External MCP
servers receive no opaque client metadata. The service exposes no file-read,
resource, prompt, write or arbitrary dispatch operation. Configuring an external
server with its reserved name fails closed.

Root and child turns keep separate provenance and source unions. Parent citations
use the existing `knowledge_sources` event and SiCore's existing append/persist
contract. Native child answers include the same original-source footer and
`knowledge_citations` metadata in their existing Runtime persistence operation.
Unrelated/internal threads, earlier turns and old tool calls acquire no citation
authority. Resume requires new reads for the new turn.

Source titles/claims/excerpts are sanitized before publication; credential-bearing
URLs are withheld and cause a safe failure. Citation results include a safe
message in `structuredContent`, because native Codex can prefer it over MCP text.

## MCP errors

The shared parent/child projection consumes both native `item.result` and
`item.error`. Safe error-only messages survive tool end events, transcript cache
and Runtime/SiCore persistence. Valid result content is preserved. Error text is
sanitized with the owning brain's live credential gate before any truncation;
redaction failure produces a fixed safe reason. This does not restore raw
upstream exception details suppressed by the MCP security gateway.

## Verification

Targeted tests cover read provenance, unread/partial/changed/symlink/private
refusal, source URLs, root/child/turn isolation and error persistence. The pinned
source-built `codex-knowledge-smoke.mjs` exercises native reads, tool search/MCP,
private-path and unread failures, parent and real child citations, cold resume,
fresh-turn reads and actual model request bodies. Standard security/brain/script/
stream/executor image gates remain required. Live SiCore acceptance must use the
existing knowledge import/binding/sync pipeline and check `knowledge_sources`,
original links, parent/child attribution and nonempty safe error rows separately
from the model's own acceptance claim.

Large JSON incremental redaction, native-memory isolation, Portal UI and the
other deferred product work retain their existing scope boundaries.

## Accepted on 2026-10-07

- Implementation `4e631b3e`: **420 files / 8760 tests**, TypeScript and build pass.
  The Codex source pin remains `d4684bba`; no upstream patch, production
  dependency, frontend or SiCore code change is introduced.
- Linux source-built validation image passes six gates: knowledge citations,
  pre-model MCP security, native brain/child/plan/resume/Stop, reviewed scripts,
  streams and executor UID/connection/cleanup. The knowledge gate checks actual
  model request bodies, root and real child sources, unread/private refusals,
  error reason and fresh reads after cold resume. CLI/code-mode binaries are
  reused unchanged from the previously verified immutable source-built parent.
- The independent `siclaw-native-validation-runtime` selects
  `codex-citations-4e631b3e`, digest
  `sha256:07f11ef2133ebda4b9b6d86723598ff847df8932c77a14d1bd5e43769ac4e1fb`.
  Actual test Pod `imageID` matches that digest.
- Real SiCore/Responses session `4d2fcb58-8da4-4002-9756-59a7fc501b96` uses an
  OKF package imported and bound through SiCore's existing interfaces; AgentBox
  consumes the existing shared knowledge bundle. Root native reads/cite emit
  `knowledge_sources`, append the original-source link, and persist
  `knowledge_citations`. Unread and `/etc/shadow` citation requests are refused.
- Actual native child `9cabac13-887b-4ed1-a48d-844a9a3f84d1` independently reads,
  cites and persists its own original-source footer and attribution. The native
  spawn/wait/close lifecycle is observed. Five failed tool rows all retain
  nonempty safe reasons. Verification parses the actual SiCore string metadata,
  independently of the model's acceptance statement.
- The first child used `head` to return a complete short page. This exposed the
  earlier cat-only provenance rule; complete head/tail results now qualify by
  exact output comparison. Partial or transformed results remain rejected.
- Original resource bindings are restored and the temporary synthetic knowledge
  repository is deleted. No namespace RBAC or shared-PVC permission is changed.
  The isolated Runtime/test Agent remains available for future acceptance.
