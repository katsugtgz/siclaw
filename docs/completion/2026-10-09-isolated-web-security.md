# Isolated native Web acceptance

Date: 2026-10-09, Asia/Shanghai. User-authorized temporary Web Agent only;
no main merge/push, production change, Feishu policy expansion or automatic
identity re-link. Upstream Codex and Code Mode remain pinned and unpatched.

## Setup and actual target boundaries

Agent `9a217de5-c613-4d93-b838-dc4796e51014` used the existing published SRE
model, `gpt-5.6-luna`, on `native-codex-20261006`. No Feishu bot, API key or
public invocation entry was configured. The test organization had one member,
the test account; this does not exclude organization/platform administrators.
The SRE release had no inherited resource items on this Runtime.

SSH used a newly encrypted credential on authorized node 061. Existing node
062 metadata had no credential and was neither modified nor bound; SSH 062
positive acceptance was skipped. Two disposable Pods ran as UID 1001, without
automatic ServiceAccount mounts. A separate 30-minute credential allowed
get/exec only into those exact Pods. The operator admin identity was never
copied to an Agent credential. The token was refreshed once with identical
scope after an initial TLS-handshake timeout made no changes.

The test MCP could only GET those Pods through a different least-privilege
ServiceAccount. It exposed strict projected state and a bounded delay, not
shell/SQL/HTTP forwarding. A synthetic transport-secret echo and a harmless
writer counter tested gateway redaction/admission; the writer was never called.
The knowledge package contained synthetic text only, no business data or code.

## Real Web observations

| Case | Evidence and result |
| --- | --- |
| Infrastructure R1 | Session `1e020645-df78-44b2-8473-9b41b537bc5e`, trace `c654b38e731117288e355242058831b2`: actual SSH 061 returns UID 0; both Pod exec calls return UID 1001; all exit 0 |
| MCP R1 | Same session, trace `3ef4dca04b16398250a3d0d5a3720aa8`: two actual atomic Pod reads; zero writer calls |
| Knowledge initial failure | Same turn incorrectly searched the MCP resource catalogue; this was not successful knowledge acceptance |
| Knowledge native R2 | Trace `bb3d49a76d35160f1bb367c39d9d39d4`: actual selected index and procedure reads exit 0 |
| Knowledge discovery R3 | Fresh session `8ed0e9ac-1a5a-46fa-9837-1d07ca94d302`, trace `78d1bd6c295d642781a84accb2794c67`: query names only the bound library; reads index/procedure and returns correct synthetic marker without a user path or previous answer |
| Policy denials | Trace `9f2ef976d6fb7a1cd43d5ac448a07045`: MCP namespace/tenant overrides fail before upstream dispatch; harmless inline Python fails before process start; nonexistent unbound SSH target refuses |
| Running refresh | Trace `cad47ba3d639b865b4c3ce930bcbb76f`: refresh during a 50-second MCP call restores the same session; exactly one upstream start/finish, no replayed execution |
| Stop | Trace `200f108f680464c0133dad1455447727`: UI interrupted; upstream `live_stop_r2` records cancelled, not finished |
| Mid-flight unbind | Trace `289a45fda0464e80450a8bab7dce0e7d`: upstream readonly operation finished, but fresh authorization suppressed delivery; persisted tool error explicitly forbids retry |
| Live output redaction | Trace `84d828e50429ca0b82d47ac1f31f750d`: literal authorized Pod `printenv` exits 0; its synthetic sensitive value becomes a redacted placeholder before persisted output |
| Knowledge removal | Trace `3de08f4702e5761d48103acda9784b8e`: old page read actually returns file missing after unbind, rather than a historical answer |

The first redaction attempt used a compound command and was refused; it is not
counted as successful execution. Discovery also made two disallowed preliminary
file-command attempts before successful reads. These failures remain recorded.
The final SSH removal prompt used an unsupported `ssh:` environment selector,
not the supported `siclaw` + brokered `ssh` command. Its UI refusal is **not**
proof of live cached-SSH binding revocation. The separate native infrastructure
gate covers removed broker bindings; an additional live cached-SSH probe remains
unverified. No target writes were used to demonstrate denial.

## Knowledge repair and checks

The adapter now explains that bound knowledge is a selected local text mount,
not an MCP resource catalogue: use native execution for its index and referenced
pages, stop on refused/missing reads, and use `knowledge_cite` only after verified
reads. Only enabled native knowledge receives this guidance. No core prompt,
read roots, dependency, credential group or upstream code was changed.

112 focused tests, strict typecheck/build and **9,011 full tests** passed.
Six earlier Linux native security gates and their 770 focused checks are recorded
in [the alignment follow-up](2026-10-09-codex-security-alignment.md).
The bounded MCP contract evaluation passed 10 scalar checks using four direct
SDK readonly calls; this is not a general business-tool/LLM benchmark.
Final fixture counter: nine reads (five native, four SDK), zero writer calls.
Known login/SSH/MCP secrets and tested encodings were absent from owned persisted
messages; no raw JWT or synthetic Pod canary remained. Live provider request
bodies were not captured; deterministic native Responses-body checks are a
separate proof, not a claim about every provider's traffic or arbitrary secrets.

## Deployment and cleanup

Only test Runtime generation 48 changed: digest
`2cf91d854fd9025f4057a71b22a5d506ef376f4865f7a9ab996b64cf1b239f1d`.
The fresh running AgentBox used digest
`c45c689d3ba7ed15f4741cb84c99decae24888c8a916795a7afe9af20df81499`;
source archive `1984b7e89a54aa67640f581efb53833786c3cf53fb3ea51025b91037af865534`.
API generation 23 and original Agent/group policy stayed unchanged.

All eleven new API records were deleted via normal management APIs, including
the Agent, MCP, knowledge package, host/cluster, two encrypted credentials and
four groups. Deletion was verified via absent lists and normal 404 responses;
the deleted Agent gate deliberately returns 403. Original bindings and existing
062 were preserved. All thirteen owned Kubernetes fixtures were checked by UID,
namespace and owner, then normally deleted and verified absent. The temporary
MCP forward was closed and its local synthetic key/key-bearing manifest removed.
Disposable resources have no product restore path; sanitized evidence remains
under private `siclaw-live-policy.M4JZA2` test files.

Remaining limits: real multi-member/cross-group/duty-group and external OAuth
acceptance; SSH 062 and the additional live cached-SSH revocation probe; broad
model/provider coverage. Native memory isolation, incremental >8 MiB structured
redaction, production write approval, Cross-Agent handoff and Portal UI remain
deferred. Do not call this production certification or arbitrary-code safety.
