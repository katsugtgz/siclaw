# Ticket watch result MCP

A standalone stdio MCP for one turn of **following an L1 ticket**.
`submit_ticket_watch_result` validates the turn's receipt and returns the same
JSON object in MCP text and `structuredContent`. It reads and writes nothing:
no ticket system, no messages, no scheduling. The harness that dispatched the
run stores the result and acts on it.

This is the in-flight follow only. The other result contracts in this directory
belong to different moments of a ticket's life: pre-ticket intake keeps
[product-support-result](../product-support-result/README.md), the pre-handoff
closure keeps [ticket-closure-result](../ticket-closure-result/README.md), and
the post-closure retrospective keeps
[ticket-review-result](../ticket-review-result/README.md).

## Why a result tool at all

The assistant following a ticket is **stateless**; the harness is stateful.
Every run starts from nothing, is handed one row, and ends. This result is the
entire handover — the only thing a run leaves behind, and the only material the
next run (possibly in a fresh session, possibly two days later) will have.

The platform makes the submission mandatory through the Agent's result contract
(see [Assistant and API setup](#assistant-and-api-setup)), so a run that ends
without calling this tool fails with `TURN_RESULT_MISSING` rather than silently
losing its turn. The contract belongs to the Agent, not to one dispatch: sicore
enforces it on every strict `/run` dispatch and, for a ticket-type Agent, on its
Web and channel conversations too. An L1 engineer chatting with this assistant
therefore also gets a turn that ends in a submission; an assistant meant for
free conversation should be a separate Agent without this contract.

## Output contract

```json
{
  "state": "watching",
  "next_check_after_seconds": 300,
  "last_seen_message_id": "1047",
  "open_sre_tasks": ["task-abc"],
  "understanding": {
    "timeline": "13:50 起海外 MaaS API 报 404，三次复现",
    "ruled_out": [{ "claim": "网关不健康", "by_task": "task-abc" }],
    "open_questions": ["客户用的是哪个模型，尚未说明"],
    "from_l1": ["这个客户是 VIP，优先级提高"]
  },
  "note": "已派排障任务 task-abc，等结果"
}
```

| Field | Meaning | Bound |
| --- | --- | --- |
| `state` | `watching` · `waiting_sre` · `waiting_l1` · `done` | required |
| `next_check_after_seconds` | Floor on when to wake this follow again. Required unless `done`, where it must be **absent**. | 60–3600 |
| `last_seen_message_id` | Group-message cursor. | ≤64 characters |
| `open_sre_tasks` | Investigation tasks still in flight, as a whole list. | ≤10 ids, ≤64 characters each |
| `understanding.timeline` | Established facts in order. | ≤1500 characters |
| `understanding.ruled_out` | `{claim, by_task}` — causes an investigation excluded. | ≤10 entries; claim ≤300 |
| `understanding.open_questions` | What is still unknown, including unproven suspicions. | ≤10 entries, ≤300 each |
| `understanding.from_l1` | What the L1 engineer said that should outlive this run. | ≤10 entries, ≤300 each |
| `closure.modules` | Component tags as the channel's `module_id` values, as a whole list. | ≤10 ids, `^[a-z][a-z0-9_-]*$`, ≤64 characters each, no repeats |
| `closure.description` | The problem itself — symptom, scope, environment, since when — as the customer may read it. | ≤2000 characters, the pre-ticket assistant's bound |
| `closure.result_type` | Proposed fault or consultation type, one line. | ≤100 characters |
| `closure.result` | Proposed cause and actions, or the answer, as the customer may read it. | ≤2000 characters |
| `note` | One internal line about this run. Required when `state` is `done`. | ≤500 characters |

Strings are returned trimmed; nothing is coerced, defaulted or truncated.
Oversized input is rejected so the model can shorten its own text — a silent
clip would drop the end of a timeline and the next run would inherit the damage
as fact.

## Three rules that are not decoration

### A turn that did nothing is a complete result

```json
{ "state": "waiting_sre", "next_check_after_seconds": 900 }
```

That is legal and changes nothing stored. Following a ticket is mostly silence:
no new messages, an investigation still running. A contract that demanded a
narrative every turn would get one invented.

### Present replaces, absent leaves alone

Update semantics mirror the ticket system's own `update_for_ai`, which the team
already knows: a field present in the result replaces that field; a field absent
leaves it alone; there is no merge inside a field. So the assistant re-curates
what is worth keeping instead of appending forever, which is what keeps the
injected context flat as a ticket ages.

Consequences worth stating:

- `[]` on a list is a real retraction — "nothing is ruled out any more",
  "no investigation is in flight". Omitting the field is what leaves it alone.
- `understanding: {}` is legal and changes nothing.
- `null` is **rejected** on every field. The difference between "clear this" and
  "do not touch this" is exactly what the caller must not have to guess.

### Nothing is ruled out without a task that ruled it out

`by_task` is mandatory on every `ruled_out` entry, and its refusal message
points at `open_questions`, where a suspicion belongs. A confident wrong
exclusion is far more damaging than a missing fact: whoever reads the
`understanding` next — including an investigator receiving it as a brief —
cannot see where the claim came from and has no reason to doubt it.

What this tool can enforce is that the citation exists. It holds no state, so it
cannot check that the task exists or that it concluded any such thing. That
check belongs to the harness, which knows the ticket's own task history; until
it lands, the guarantee here is structural, not evidential.

### Closure fields are a proposal, and the harness writes them

`closure` is the assistant's running proposal for what the engineer will
confirm when they mark the ticket resolved. It follows the same
present-replaces rule as `understanding`, and each field holds one kind of
content, so none has to be read to know what another says:

| Field | Holds | Never holds |
| --- | --- | --- |
| `description` | The problem: symptom, scope and impact, environment, since when | The cause or what was done |
| `result_type` | Its category, one line | Detail |
| `result` | The cause and what was done, or the answer given | Hostnames, task ids, tool names |
| `modules` | The components, as `module_id` values | — |

`description` starts where the pre-ticket assistant left it: a customer who
could not explain the problem to it often can once an engineer is talking to
them, and the follow folds what that conversation established into the same
text rather than appending to it.

The tool writes nothing. The harness writes all four fields to the ticket after
the turn is stored, and it is the harness that can see what this tool cannot:
it reads the ticket first, replaces the pre-ticket `description` and `modules`
it found at the claim, never overwrites a field a person has changed (that
field is theirs from then on), and stops writing once the ticket leaves the
handling states. The engineer's resolve form shows the current values as
defaults, so the person confirming is always the last writer.

## What is deliberately absent

- **No state the agent can reschedule itself with.** The lease, the fencing
  token and the failure count are the harness's. The agent proposes a next check
  and nothing more.
- **No `stalled`.** It exists in the harness as its verdict after repeated
  failed runs. A run that believes it is stuck is still `watching` and says so
  in `note`.
- **No write the agent makes itself.** `closure` is a proposal; the harness
  decides whether it reaches the ticket, as described above. Nothing is ever
  written to the group.
- **Nothing reaches the customer without a person.** `closure.result` becomes
  customer-visible only when the engineer submits the resolve form, with the
  proposal as its default. `note` stays internal to the team.

## Assistant and API setup

The AgentBox image builds every package in [`mcp/MCP_LIST.txt`](../MCP_LIST.txt)
and exposes the binary on `PATH`:

```json
{
  "name": "ticket-watch-result",
  "transport": "stdio",
  "command": "mcp-ticket-watch-result",
  "args": [],
  "env": {}
}
```

Bind it to the ticket-following assistant alongside its read tools, and point
the Agent's result contract at it (`kind: mcp_tool`, this server's id,
`submit_ticket_watch_result`, `required: true`). No platform code is involved:
sicore resolves the contract to `mcp__ticket-watch-result__submit_ticket_watch_result`
and enforces it for the turn.

### One prompt line is load-bearing

The instance prompt must say to submit **exactly once, as the last thing in the
turn, and never a second time**. This is not boilerplate. Measured against a real
model: the turn that first had to read the ticket called the tool once, while the
turn whose only action was the submission called it **three times** and failed
with `MULTIPLE_TURN_RESULTS`. A scheduled follower's normal turn is exactly that
second shape — nothing to do but report — so the line is what keeps the common
case working. The same rule already appears in
[support-prompt.md](../../examples/support-review/support-prompt.md).

An omitted result does not simply fail either: the runtime repairs the omission
by forcing the call, and a prompt that fights the repair can produce several
submissions instead of none. A caller should treat `TURN_RESULT_MISSING` and
`MULTIPLE_TURN_RESULTS` the same way — this run produced nothing usable.

## Verification

From the repository root:

```bash
npx vitest run mcp/ticket-watch-result
npm run build --prefix mcp/ticket-watch-result
```
