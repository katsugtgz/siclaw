# Ticket closure result MCP

A standalone stdio MCP for the **pre-handoff** closure summary: the customer
clicked resolved while the ticket was still with the customer-support assistant,
so the ticket closes without ever reaching a human.
`submit_ticket_closure_result` validates the result and returns the same JSON
object in MCP text and `structuredContent`. It does not read ticket systems,
send messages, update fields or close tickets.

This is the pre-handoff operation only. After handoff the closure fields are
maintained by the ticket troubleshooting role writing to the ticket system
directly, and the customer-support resolved action is unavailable. The
pre-ticket intake result keeps its own contract
([product-support-result](../product-support-result/README.md)), and the
post-closure retrospective keeps its own
([ticket-review-result](../ticket-review-result/README.md)).

## Output contract

```json
{
  "description": "用户在控制台登录后持续返回 HTTP 500，重试三次可复现。受影响模块为控制台（Web UI）。",
  "result_type": "控制台登录 500",
  "result": "浏览器缓存的过期会话导致登录失败；清理站点数据后重新登录恢复，用户已确认可用。"
}
```

| Field | Meaning | Bound |
| --- | --- | --- |
| `description` | Ticket background: the original need, the facts the conversation established, and the affected module when known. | ≤2000 characters |
| `result_type` | A short concrete category for the outcome — a fault type or a consultation type. **Free text, single line.** | ≤256 characters |
| `result` | For a fault, the cause and the actions taken with how the outcome was verified. For a consultation, the answer given. | ≤4000 characters |

All three are required and must be non-blank after trimming. Extra fields are
rejected. Values are returned trimmed and otherwise unchanged — nothing is
coerced, defaulted or truncated.

### Why the three fields are shaped this way

They are the columns of the consuming ticket system's closure form. That form
switches its labels by ticket type — for a fault 故障类型 / 故障描述 /
故障原因及处理操作, for a consultation 咨询类型 / 咨询描述 / 解答说明 — while the
columns stay the same, which is why one shape serves both.

`result_type` is **not an enum**. The consumer stores it as required single-line
free text with a 256-rune cap and publishes no value list, so this tool bounds
the field and never judges the wording: there is nothing to validate against,
and a list invented here would refuse values the human form accepts. Wording
guidance belongs in the Agent prompt. Two consequences worth knowing:

- The validation-feedback loop that works for enum fields (reject a value
  outside the list, ask the assistant to correct it) has no basis here.
- Two runs over similar material will not produce byte-identical text, so a
  consumer that skips writes on equality will still see a change nearly every
  time. Callers that write repeatedly need their own "no material change" gate.

`result_type` is also **not the ticket's own classification** — the ticket
already carries that. Conflating them produces a closure category that merely
repeats 咨询 / 故障.

### Honesty rules the schema cannot enforce

The customer clicks resolved whenever they choose: they may have decided it was
a consultation, or realised the mistake was their own, and ended the ticket
before a human arrived. Whatever exists at that moment is the whole of the
available material.

- A recovery the user reports is not a proven cause. Where no cause was
  established, say so in `result` and describe what was actually observed.
- `result_type` must stay honest when the classification itself was never
  settled (`登录异常（原因未确认）` rather than a guessed fault type), and must
  read sensibly under either form's label.
- Never describe an action nobody took.
- A user's own "I had it wrong" is a valid outcome; record it as such instead of
  rewriting it into a technical fault.
- A ticket with no conversation at all should not reach this tool — the caller
  closes it with its own system text rather than asking a model to summarize
  nothing.

Length limits reject rather than truncate: the model can shorten its own text,
while a silent clip would drop the end of a causal explanation without telling
anyone. Validation failures return `isError=true` without `structuredContent`.

The MCP is stateless. Ticket identity, whether the ticket is still pre-handoff,
material completeness and causal correctness all come from the caller and the
conversation; schema validation establishes none of them.

## Assistant and API setup

Build with `npm ci && npm run build` in this directory. The AgentBox image
builds every package in [`mcp/MCP_LIST.txt`](../MCP_LIST.txt) and exposes the
binary on `PATH`:

```json
{
  "name": "ticket-closure-result",
  "transport": "stdio",
  "command": "mcp-ticket-closure-result",
  "args": [],
  "env": {}
}
```

Bind this MCP to the **existing customer-support instance** alongside its intake
result MCP. The closure summary is produced by that same assistant, in the same
conversation it has been having with the customer — it already holds the
context, so no transcript is passed anywhere.

Which result is mandatory is decided per dispatch, not per instance, so one
instance can own both contracts: an ordinary support turn requires
`submit_product_support_result`, while a closure request requires
`submit_ticket_closure_result`. The instance prompt needs a matching branch —
see the `【结单总结】` rule in
[support-prompt.md](../../examples/support-review/support-prompt.md). Without
that branch the assistant will keep trying to submit the intake result.

## Verification

From the repository root:

```bash
npx vitest run mcp/ticket-closure-result
npm run build --prefix mcp/ticket-closure-result
```

Contract tests cover the required fields, blank and non-string values, extra
fields, single-line enforcement on `result_type` (including U+2028 / U+2029),
code-point length counting against the consumer's rune cap, raw-versus-trimmed
length, and real MCP client/server calls. For model acceptance, supply only
inputs — never expected outputs — and include a resolved question, a fault with
a confirmed cause, a recovery with no established cause, a user who reports
their own mistake, and a conversation of one or two turns.
