# mcp-product-support-result

A stateless stdio MCP server that validates and serializes the handoff decision
for a product-support conversation turn. It has no network access and performs
no ticket, group, or notification side effect.

## Tool

`submit_product_support_result(label, info)` returns the canonical result as
both MCP text content and `structuredContent`.

```json
{
  "label": true,
  "info": {
    "ticket_type": "incident",
    "product": "Example Product",
    "summary": "Training task cannot start",
    "description": "Task task-123 remains Pending after retry.",
    "evidence": ["task_id=task-123", "status=Pending"],
    "missing_fields": []
  }
}
```

`ticket_type` is one of `consultation`, `incident`, `llm_incident` or
`requirement`. A `label=true` result marks the Agent's final
conversation turn: intake is complete and the channel can offer its human
handoff button. The user triggers that workflow; the result itself does not
initiate a handoff or create a ticket. End with an acknowledgment that the
information is prepared, without further questions or claims of completed actions.

### Every turn is handoff-ready material

A channel may hand the ticket to a human at any moment without another Agent
turn — for example when the user presses an urgent-handoff button. First-line
support then receives the **latest** result as it stands. Every result,
whatever its `label`, therefore carries:

- a non-empty `description`: a self-contained account of the user's issue, the
  facts established so far and what has been answered, updated each turn;
- the most likely `ticket_type` from the conversation so far. While
  `label=false` it is provisional and may change as the user clarifies; there is
  no `unknown` value to fall back on.

A `label=true` result must additionally provide a non-empty summary and have no
blocking clarification fields. An empty `missing_fields` means no further Agent
clarification is needed, not that every fact is known.
Requirements must also name a concrete product grounded in product knowledge.
For incidents and consultations, a concrete `product` must be established by
the conversation or authoritative product knowledge; otherwise leave it empty,
preserve the user-visible entry in `description`, and let first-line support
determine ownership. `missing_fields` contains lowercase `snake_case` machine
identifiers only, never questions or diagnostic instructions.

### `llm_incident`

`llm_incident` is the fault type for problems while calling an LLM / model API
or inference endpoint: gateway errors, authentication and rate-limit or quota
failures, broken streaming, or a specific named model misbehaving. `incident`
remains every other fault.

The `llm` block carries the intake details first-line support routes an LLM
incident on:

```json
{
  "label": true,
  "info": {
    "ticket_type": "llm_incident",
    "product": "",
    "summary": "Chat completions return 429",
    "description": "Every request to the model API has returned HTTP 429 since this morning.",
    "evidence": ["HTTP 429", "model=example-model-v2"],
    "missing_fields": [],
    "llm": { "region": "overseas", "aspect": "model", "model": "example-model-v2" }
  }
}
```

| Field | Values | Meaning |
| --- | --- | --- |
| `llm.region` | `""`, `domestic`, `overseas` | Deployment region the user calls from, per the operator's own classification rules |
| `llm.aspect` | `""`, `platform_api`, `network`, `model` | Failing part of the path: the API platform or gateway, network reachability, or a specific model |
| `llm.model` | free text | Model name as the user stated it |

Fill each field only from what the conversation establishes. While still
gathering (`label=false`) any of them may be empty, and the identifiers
`llm_region`, `llm_aspect` and `llm_model` may appear in `missing_fields`. A
`label=true` `llm_incident` requires `region` and `aspect`, and `model` when
the aspect is `model`: the Agent asks for them instead of handing off without
them. A user who needs a human before answering has the channel's own handoff
action, which does not wait for a `label=true` result. For `consultation`,
`incident` or `requirement`, all three fields must be empty, so a stray value
is never read as an established fact; unconfirmed clues belong in
`description` and `evidence`. The block is optional on input: omitting it means all three
fields are empty, which is the correct value for every type except
`llm_incident`. It is always present in the returned result.

### Size limits

The validated result is persisted downstream as one row's metadata, so every
field is bounded and an oversized value is rejected here, where the model can
shorten it. Limits are in characters, not bytes.

| Field | Limit |
| --- | --- |
| `summary` | 200 |
| `description` | 2000 |
| `product`, `llm.model` | 128 |
| `evidence` | 20 items, 300 characters each |
| `missing_fields` | 20 items, 64 characters each |

Limits apply to the raw value before trimming, exactly as a host that
validates the advertised schema before dispatch applies `maxLength`, so the
parser is never more lenient than the schema the model was shown.

### Canonicalization

The parser mirrors the advertised JSON Schema and adds nothing the schema does
not say: enum values (`ticket_type`, `llm.region`, `llm.aspect`) must be the
exact lowercase spelling. String fields are trimmed. `evidence` and
`missing_fields` items are trimmed and post-trim duplicates are removed, so the
returned arrays can be shorter than the caller's.

The server validates each call independently. It does not know Siclaw session
or turn identity, so "exactly one successful result per turn" is not enforced
here — the caller that consumes the result owns that rule.

## Portal MCP config

```json
{
  "name": "product-support-result",
  "transport": "stdio",
  "command": "mcp-product-support-result",
  "args": [],
  "env": {}
}
```

The binary is built into the AgentBox image from `mcp/MCP_LIST.txt` and linked
as `mcp-product-support-result` on `PATH`, so the config above needs no
absolute path.

A successful call appears in the streamed `tool_execution_end` event for
`mcp__product-support-result__submit_product_support_result`, carrying the
validated object as MCP `structuredContent`. A control plane that pins this
full tool name as an Agent's required result tool can therefore treat that
object as the turn's single machine-readable outcome, and fail the turn closed
when it is absent, duplicated, or upstream-failed.
