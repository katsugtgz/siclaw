# Native Codex public web research

Each Agent stores `web_search_mode`: `disabled` (legacy/default), `cached`, or
`live`. The authenticated Agent configuration, not chat arguments or process
environment, supplies this setting. Pi does not consume it. SiCore and the local
Portal backend persist it; the SiCore Agent form exposes it only for Codex.

The Runtime sends the mode through the Agent-owned tools sync. Each prompt
refreshes it from the authenticated control plane. Changes invalidate resident
brains for their next idle turn; running turns finish with the old setting.
There is no automatic switch to another search service, browser, shell network
access or model if the configured Responses provider cannot search.

## Native protocol and security boundary

The fixed Codex source `d4684bba` supports hosted Responses `web_search`, with
`external_web_access: false` for cached and true for live mode. Responses Lite
models (including the pinned Luna/Astra catalog) cannot carry hosted tools and
need native `web.run`. Enabling search sets `supports_standalone_web_search` for
the same configured provider; native Codex calls that provider's `/alpha/search`.
The flag requests a service, it cannot implement it: providers without that
endpoint cannot complete native Lite search. There is no upstream patch or
automatic alternative endpoint/provider. Standard Responses retains hosted search.

This is provider-owned research, **not a Siclaw atomic production operation**.
Search calls do not traverse the exec-server command gate. Query text can leave
the AgentBox and live mode may retrieve external pages. Native standalone search
also includes recent conversation input in the search request to that same model
provider. Cached mode still sends queries/context to the provider; it is not a
local/offline privacy guarantee.

Existing credential brokering, pre-model execution/MCP output sanitization,
filesystem isolation, JS sandbox and infrastructure authorization remain
unchanged. No kubeconfig, SSH password, MCP or provider secret is granted to the
model by enabling search. A web page cannot authorize a production operation.

Adapter guidance requires generic public technical queries, no private host/IP,
customer identifiers or raw logs, untrusted treatment of results and explicit
source links. That guidance is not a hard query DLP control. Native hosted
search does not expose a Siclaw pre-query authorization/redaction hook: do not
claim the command whitelist audits or redacts search terms before dispatch.
Keep search disabled where that additional guarantee is mandatory; a separate
governed search boundary would require its own design and implementation.

Native `webSearch` start/completion events are projected as `web_search` tool
activity. A bounded metadata allow-list is sanitized before UI/history delivery.
Opaque provider result structures are not blindly copied into public events.
This is post-search presentation redaction, not prevention of query egress.
The assistant retains its native answer/source links. No synthetic citations or
successful search events are invented when the provider fails.

## Upgrade and acceptance

The additive, idempotent SQLite/MySQL migrations default existing Agents to
disabled, preserving egress scope. Deploy matching SiCore, Runtime and AgentBox
versions; explicitly opt in the desired Agent. Recycle old AgentBox images via
their normal idle/rebuild lifecycle before claiming the new setting is active.

Acceptance covers exact mode validation, per-Agent isolation, next-turn reload,
native advertised tool modes, real native search events and citations, UI/history
redaction, unchanged shell/MCP restrictions and a real supported-provider search.
Synthetic native protocol tests are not evidence of provider search support.
