# mcp-siticket

Read-only stdio MCP server over the Siticket OpenAPI. It gives an agent what it
needs to follow one ticket: the ticket record, the conversation attached to it,
the images posted in that conversation, and the product module table tickets
are routed on.

There is deliberately **no tool that lists or searches tickets**, so an agent
cannot walk the ticket list. That is not isolation: every read names a ticket
id, and an unpinned process reads **any ticket the token can see** once it has
an id — from its dispatch, or from text inside a ticket it already read. A
deployment that serves one ticket should set `SITICKET_TICKET_ID`, which refuses
every other id before a request is sent.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_ticket` | `ticket_id` | Status, title, the customer's original query, the accumulated description, handlers, reviewers, watchers, closing result and result type, the customer and processing group ids, and the start/finish/end timestamps. |
| `get_ticket_messages` | `ticket_id`, `after_message_id?`, `limit?` | One page of the ticket's conversation, oldest first, plus `ticket_context`, `has_more` and `next_after_message_id`. `limit` is 1–500 (default 50; Siticket's own default is 100). |
| `view_ticket_image` | `ticket_id`, `url` | The image itself (MCP `image` content: PNG, JPEG or WebP, at most 6 MB), with its url, type and size. Only a url that `get_ticket_messages` returned as an `image` attachment of the same ticket is accepted. |
| `list_ticket_modules` | — | Every module row: `primary_product` / `secondary_system` / `tertiary_component` with owners, plus `l2_support`, `l3_owner`, `major_incident_lead`, `incident_decision_maker`. |

Several properties of the upstream data are worth stating, because each one
invites a wrong conclusion that the payload alone does not correct:

- **The conversation is a filtered subset, not the raw group transcript.**
  Siticket returns what it considers readable for this ticket, so message ids are
  not contiguous and earlier ids may be absent by design. A gap is not loss.
- **An empty page can mean "not claimed yet", not "nobody spoke".** An unclaimed
  ticket answers 200 with `session_opened: false`, no messages and a complete
  `ticket_context` — the same shape as an open but quiet group. The server adds a
  `reading_note` in that case; the field is ours, not Siticket's.
- **A retryable failure is about the sync, not the ticket.** While the transcript
  is still syncing, Siticket answers `40901` with `retryable: true`. The tool says
  the condition is transient, that `get_ticket` still works, and that the retry
  must back off — Siticket allows about 60 requests per minute per token, so a
  tight retry loop spends the whole budget inside one wait.
- **A success is never partially complete.** `history_complete` is only ever set
  on the success path, so a 200 carries the whole history up to its cursor.
- **`ticket_context` is smaller than `get_ticket`.** It omits the group ids, the
  reviewer list and `finish_time`. Read the ticket when those matter.
- **An unresolvable attachment fails the whole page.** Siticket resolves every
  attachment on the requested page before it answers, so an unreachable object
  store means *no messages at all* come back — not a message with a missing
  image. The tool says so rather than passing a bare 502 up.
- **The two endpoints write time differently.** `get_ticket` returns UTC with no
  offset (`2026-09-16 06:07:14`), which reads as local time to everyone who sees
  it; `get_ticket_messages` returns RFC3339 with a `Z`. Both describe the same
  clock. Siticket's offset-less form is a deliberately frozen external response,
  so the tool descriptions carry the warning rather than the payload being fixed.

`view_ticket_image` exists because a customer's screenshot is often the only
exact record of an error, and a url in a tool result is text the model cannot
look at. Its bounds are what make it safe to hand to a model that reads
customer-written text:

- **It fetches only what Siticket returned.** The server remembers, per ticket,
  the `attachments[].url` of every `image` attachment `get_ticket_messages`
  returned in this process. Any other url — one written in a message's text, a
  file attachment, another ticket's image, or one made up — is refused before a
  request is sent. After a restart the model reads the messages again first.
- **The Siticket token stays with Siticket.** Attachment urls point at the
  object store, so the request carries no `Authorization` header, and a
  redirect is refused rather than followed.
- **It is bounded.** Only the formats the runtime passes to the model (PNG,
  JPEG, WebP; not SVG, which is a document) and at most 6 MB, the runtime's own
  cap on an inbound image. The body is counted as it arrives, so a missing or
  false `Content-Length` cannot make the process buffer more.

`list_ticket_modules` returns the entire table (about 73 rows, ~21 KB) with no
filter. Deciding which module a symptom belongs to is a judgement about wording,
not a lookup, so the agent reads the table and matches the meaning. Owners are
internal nicknames: they identify who is responsible without being addressable.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `SITICKET_API_URL` | yes | Siticket base URL. HTTPS, or plain HTTP to loopback or a cluster-internal name (`siticket-apiserver`, `*.svc`, `*.svc.cluster.local`) — the deployed shape is this server running in an AgentBox beside Siticket. No credentials, query string or fragment. |
| `SITICKET_API_TOKEN` | one of | Bearer token for the Siticket OpenAPI. |
| `SITICKET_API_TOKEN_FILE` | one of | Path to a `chmod 600` file holding the token. |
| `SITICKET_TICKET_ID` | no | Pins the process to one ticket: any other id is refused before a request is sent, and the tools may be called with no `ticket_id`. |
| `SITICKET_TIMEOUT_MS` | no | Per-request timeout, 1000–120000, default 30000. |

```json
{
  "command": "mcp-siticket",
  "env": {
    "SITICKET_API_URL": "https://siticket.example.com",
    "SITICKET_API_TOKEN": "..."
  }
}
```

The token is sent as an `Authorization: Bearer` header. It never appears in a
URL, a log line, a tool result or an error message.

## Development

```bash
npm install
npm test        # unit tests, plus a stdio end-to-end test that builds the server first
```

The end-to-end test drives the built server over real stdio against a local HTTP
upstream, so the shebang entry, environment loading and JSON-RPC framing are
exercised rather than stubbed. No live Siticket is needed.
