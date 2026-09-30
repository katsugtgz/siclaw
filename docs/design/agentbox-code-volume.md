# Read-only AgentBox code volume

## Problem

An agent that operates a project's clusters can read live state but cannot read
the project's source. Diagnosis then runs backwards from symptoms with no way to
check what the running code actually does, and the agent has no cheap way to
acquire it either:

- the shell cannot run `git` (the image carries the binary since the Git
  layer below, but only the node process invokes it, never `restricted_bash`);
- `restricted_bash` is a command whitelist that, in the box's context, contains
  no `file` group at all — no `ls`, no `cat`, no `find` — and refuses text
  operands containing `/`;
- the pod's root filesystem is read-only.

So the source has to arrive as a mounted filesystem, prepared by something else,
and the agent has to reach it through the file tools it already has.

## Contract and ownership

Siclaw is a pure READER of this volume. An external supplier owns it end to end:
it creates the PVC, decides which repositories an agent may read, keeps their
bare mirrors fetched, writes each agent's manifest, and garbage-collects all of
it. Nothing in this repository ever writes to the volume, and no part of the
control-plane protocol carries a "this agent has code" field. The entire
interface between the two systems is the layout below.

### Volume layout

```
<volume root>/
├── mirrors/<host>/<path>.git     bare mirrors, shared by all agents; never mounted whole
└── agents/<agentId>/             one directory per agent, subPath-scoped
    └── .gitrepos.json            the manifest: which mirrors this agent may read
```

- `<agentId>` is sanitized with the same rule the Runtime uses for the
  `user-data` subPath: every character outside `[A-Za-z0-9._-]` becomes `_`, then
  truncated to 63 characters. This is an implicit cross-repository contract — the
  supplier writes these directory names and the Runtime reads them, so a
  divergence in one character makes the gate look at a directory nobody fills.
  `k8s-spawner.test.ts` pins the rule against the `user-data` subPath so the two
  can never drift apart on this side.
- Repositories are NOT directories here. Every commit of a granted repository is
  read at a virtual path `<repo>@<sha>` that exists on no disk (see "Git layer").
- Anything else the supplier keeps in `agents/<agentId>/` must be a FILE. The box
  sees this directory at `reposDir`, where every directory becomes a row of the
  "Code Repositories" prompt table (the scanner keeps directories and symlinks to
  them, dot-prefixed or not), and where a real directory named `<repo>@<hex>`
  would shadow that commit's virtual path.

Flat trees were removed. The supplier used to export `<repo>@<view>/` source
trees here too (`<repo>@latest`, `<repo>@<env>`), listed in `.revision.json` and
gated by a `.ready` marker. A tree pinned one commit per (repository,
environment), while what runs is one commit per (environment, service, image) —
a helm release carries several images, and one repository can run at two
commits in one environment — and every commit a tree held is readable virtually
anyway. A leftover tree is served as a plain directory until the supplier
removes it.

### The mount gate

`agents/<agentId>/.gitrepos.json` existing — not a control-plane flag — decides
whether a pod gets the code volume at all. Three reasons, in order of how much
they cost when ignored:

1. **kubelet creates a missing subPath.** A mount whose subPath does not exist
   does not fail; kubelet creates the directory on the underlying writable mount
   and the pod starts normally. The box then sees an EMPTY directory it cannot
   tell from an agent that was prepared with nothing in it.
2. **A pod's mounts are decided once.** `spawn()` reuses a Running pod after
   checking only its profile and its certificate; it does not re-evaluate
   volumes. A box that comes up without the mount stays without it for its whole
   life — until its idle self-destruct, an image roll, a certificate rotation, or
   an explicit terminate. The most common sequence for a newly enabled agent
   (enable, then immediately talk to it) is therefore also the worst one, which
   is why the supplier is expected to write an agent's first manifest as soon as
   it is asked to, not on its next periodic round.
3. **Two sources for one fact always diverge.** The manifest already states
   "a supplier has prepared this agent"; a delivered boolean saying the same thing
   can only be inconsistent with the filesystem for some window.

A missing manifest is looked for twice, ~200ms apart, before the Runtime
concludes it is absent. The volume is NFS-backed and a negative lookup for a
just-created file can be served from the client attribute cache; given (2), being
wrong is expensive and long-lived, while the retry is paid only on the miss path
and only when a code PVC is configured at all.

A missing manifest is NOT an error. The supplier is an independent system and
"not prepared" is the normal steady state of every agent that has no source
configured. The box spawns without the code volume and the Runtime logs why.

Once the manifest EXISTS, the pod always gets `agents/<agentId>/` at `reposDir`,
whatever the file says: an invalid manifest, one the Runtime cannot read, or one
whose every entry is rejected still gets the directory — with no mirrors — so the
box reads the same file and tells the agent why nothing is readable
(`manifest_invalid`) instead of looking like an agent with no code.

🔴 **It is a DIRECTORY mount, never a subPath onto the manifest file.** The box
re-reads the manifest while it runs (that is how revocation works without a
restart), and the supplier replaces it by an atomic rename. A file subPath binds
the inode that existed at mount time, so the box would read its first manifest
forever.

### What the agent sees

The directory mount is at `/app/.siclaw/repos` — the configured `paths.reposDir`:

- it is already in the file tools' read whitelist, so the virtual `<repo>@<sha>`
  paths under it pass the same allow-list gate as any other read;
- the AgentBox entrypoint chowns `credentials`, `skills`, `user-data` and
  `config` and deliberately does NOT touch `repos`, so a read-only mount there
  cannot fail its `set -e` startup.

The only real file there is the manifest. The code itself is the virtual paths,
which no `ls` shows, so the "Git history" section of the knowledge overview is
how the agent learns the addressing rule and the readable repositories (see
"Prompt"). Nothing is a working copy: no `.git`, no shell access, and
`readOnly: true` on every mount. The agent reads with `read`, `grep`, `find` and
`ls`, and reads history with `git_query`.

### Permissions

The supplier writes directories `0755` and files `0644` (the manifest and the
mirrors alike); the box process (uid 1000) reads through the other bits.

🔴 **Do not add `fsGroup`.** kubelet chowns a volume RECURSIVELY at mount time.
On an NFS-backed mirror pool of hundreds of thousands of files that is one
SETATTR per file; it consumes the entire `startupProbe` window and the container is killed
before it answers a single probe. The same failure is recorded in
`docker/agentbox-entrypoint.sh` for `user-data`. The other bits are the mechanism
here; group ownership is not.

🔴 **`readOnly: true` goes on the volumeMount, never on the volume source.** A
`readOnly` persistentVolumeClaim source is staged read-only by the CSI driver and
leaves the pod in `ContainerCreating` until the spawn deadline expires — a
multi-minute failure whose events blame the driver rather than the pod spec.

## Configuration

One switch, and it is infrastructure only:

| Where | Key | Meaning |
|---|---|---|
| Helm | `agentbox.codeVolume.claimName` | Name of the pre-existing RWX PVC. Empty (default) ⇒ feature off. |
| Runtime env | `SICLAW_CODE_CLAIM_NAME` | Same value; what the chart injects. |

When set, the chart also mounts that PVC read-only into the Runtime at
`/app/.siclaw/code-root`, which is how the Runtime reads each agent's manifest
and checks the mirrors it names. That path is never handed to an AgentBox; each
box receives subPath-scoped mounts of its own `agents/<agentId>/` directory and
of the mirrors its manifest grants, and can reach neither another agent's
manifest nor the volume root.

There is no paired `enabled` policy flag and nothing arrives per-agent over the
control-plane protocol — see "The mount gate" (3). The chart never provisions
the PVC.

**With the claim name unset, pods are byte-identical to a deployment that never
had this feature**, and the Runtime does not touch the filesystem: the claim-name
check short-circuits before the manifest lookup.

## Prompt table truncation

The knowledge overview gives the "Code Repositories" table a fixed character
budget and stops at the first row that would exceed it — roughly 16 rows,
ordered by file count descending. Before this change the remainder was dropped
silently, which is the worst possible failure for a table an agent treats as a
directory listing: it presents the surviving prefix as the complete set, so the
agent answers "that repository is not here" about a directory that is mounted and
readable.

The table now ends with a line naming the count it dropped and the tool that
lists the rest, at the mount's real path — `config.paths.reposDir`, resolved
through `modelKnowledgePath()` exactly as the wiki catalog does. The bare
`repos/` this file's prose once used is not a path any box has, so a note
carrying it would have pointed the agent at nothing. It is an improvement for every agent type, not only this one, and
it is counted against the same budget rather than exempted from it. On the code
volume the table is normally empty (the agent directory holds no directories);
the "Git history" section truncates the same visible way.

## Git layer

Every commit of a granted repository is read in place from the supplier's bare
mirrors — a deploy's commit, an MR head, the commit a failed build ran on — through
the same four file tools, at a path that does not exist on disk:

```
code volume (supplier-owned)                      AgentBox
┌──────────────────────────────────┐    ┌─────────────────────────────────────────┐
│ agents/<agentId>/                │───▶│ /app/.siclaw/repos/         (reposDir)  │
│   .gitrepos.json  (manifest)     │    │   .gitrepos.json                        │
│                                  │    │   <repo>@<sha>/    virtual, never on    │
│                                  │    │                    disk, never in `ls`  │
│ mirrors/<host>/<path>.git  ──────┼───▶│ /app/.siclaw/gitrepos/<name>.git        │
│   (one subPath mount per repo)   │    │   (gitReposDir, read-only)              │
└──────────────────────────────────┘    └──────────────┬──────────────────────────┘
                                                       │ argv-only git
                                   read / ls / find / grep  +  git_query
```

With no code claim, or no manifest for the agent, every pod and every file-tool
result is what it would be without this feature.

### The manifest

`agents/<agentId>/.gitrepos.json`, written by the supplier (a FILE, so it never
becomes a prompt-table row), replaced by atomic rename:

```json
{"version": 1, "updated_at": "…",
 "repos": [{"name": "app", "host": "gitlab.x", "path": "grp/app",
            "bare": "mirrors/gitlab.x/grp/app.git"}],
 "rules": {"exclude_dirs": ["node_modules", "vendor", "dist", "target"],
           "max_file_bytes": 5242880}}
```

- `name` is one path segment (`[A-Za-z0-9._-]{1,63}`): it is both the mount
  directory `<name>.git` and the first half of `<name>@<sha>`, with the same
  charset and cap as the agent directory names.
- `bare` is relative to the VOLUME root and must be `mirrors/<host>/…/<x>.git`.
  The Runtime never derives it: the pool's path rule is the supplier's, and a
  second copy of it here would be a second thing to keep in step.
- `rules` is the supplier's own exclusion list and file-size limit, serialised
  rather than re-typed here, so the two cannot drift.
- The Runtime and the box parse it with ONE module
  (`src/shared/code-view-manifest.ts`), because two readers of one external file
  are exactly how two interpretations appear. It is external input and is
  validated there, once, at two grains: a document that is unusable as a whole
  (not JSON, a `version` other than 1, bad `rules`) is refused entirely — rules
  apply to every repository, so it cannot be half-trusted, and an unknown
  version may have changed what a field means; a single bad or colliding entry
  is dropped and the rest are kept. A name or `bare` listed twice drops EVERY
  party to the collision — two mounts at one mountPath make the API server
  reject the whole pod, and picking a survivor would make authorisation depend
  on list order.

### The mirror mounts

Once the gate passes, the spawner parses the manifest from its own view of the
whole volume and adds one mount per surviving entry, after the directory mount:

```
{ name: "code", subPath: <bare>, mountPath: /app/.siclaw/gitrepos/<name>.git, readOnly: true }
```

- Same PVC, same volume entry: no second claim, and the two 🔴 rules above hold
  unchanged — `readOnly` on the mount, never the source; no `fsGroup`.
- Each entry is checked on disk before it becomes a mount: `realpath` must land
  inside `mirrors/` (a symlink planted on the volume must not turn a subPath
  into a window onto another agent's state), and `<bare>/HEAD` must exist —
  kubelet CREATES a missing subPath, the same trap the manifest gate exists for.
- Failure is contained, not fail-fast: an unusable manifest, an unresolvable
  pool or a bad entry is logged and mounts no mirror (or only that one is
  skipped), but the pod still spawns with the agent directory — refusing it
  would also remove the one channel through which the agent learns why.
- Mount decisions are per pod creation: a repository granted while a box runs
  becomes readable in the next cold start.

`/app/.siclaw/gitrepos` is `config.paths.gitReposDir` (`SICLAW_GITREPOS_DIR`),
deliberately not under `reposDir`: that directory is the supplier's read-only
mount of the agent directory, so nothing of the Runtime's may live in it.

### The authoritative set, and revocation

A box serves a repository's history only when it is BOTH in the manifest and
mounted (`<gitReposDir>/<name>.git/HEAD` exists). The two change on different
clocks — the supplier rewrites the manifest while the box runs, mounts are fixed
at pod creation — so each disagreement has its own refusal, because each has a
different fix:

| State | What the agent is told |
|---|---|
| in manifest, mounted | readable |
| in manifest, not mounted | granted after this box started — readable after the box's next cold start (a box is reused across sessions, so "a new session" is not enough) |
| in manifest, mounted without `HEAD` | a broken mount: the mirror was reclaimed (or not yet populated) between the spawner's check and kubelet's mount, and kubelet created the subPath as an empty directory. Reported as a mount inconsistency — never as a missing commit — and cleared by the next cold start |
| mounted, gone from manifest | access revoked — refused, although the mount stays until the next cold start |
| manifest present but unusable | nothing is readable, and why (`manifest_invalid`) |
| no manifest | no repository's history is readable (any mount is treated as revoked) |

Revocation therefore takes effect in the box without a restart. The reading is
cached for about two seconds (`ls` classifies every entry it stats; re-reading
an NFS file hundreds of times per call buys nothing), so a revocation is
honoured within that window. Removing the mount itself still takes a cold start.

An I/O failure reading the manifest or the mount point (anything but "absent")
is not reported as "no repositories": it propagates, and the session build
fails loudly, rather than silently hiding the feature.

### Virtual paths accept SHAs only

`<reposDir>/<name>@<hex>/<path>` is virtual when `<reposDir>/<name>@<hex>` does
NOT exist on disk, `<hex>` is 7–40 hex characters in either case (a SHA copied
from a UI may be upper-case; refusing it would fall through to the filesystem as
a reasonless "not found"), and `<name>` is in the authoritative set. A real
directory always wins, whatever its name: on the code volume nothing but the
manifest exists there, and the rule is what keeps a local-mode `repos/`
directory — an operator's checkout named `app@deadbeef` — the files it is.

Branches, tags and MR names are never accepted there: a branch moves, so a
conclusion drawn from `app@main` could not be reproduced an hour later, and
every conclusion is anchored to an immutable commit. Symbolic refs are turned
into SHAs by `git_query refs`; the commit an environment runs comes from the
control plane (the business prompt says how).

A short SHA is expanded and an ambiguous one refused. A SHA the mirror does not
have is `ref_unreachable`, and the message says what is true: the mirror may not
have fetched it yet (a push is usually synced within seconds, at the latest by
the supplier's next full round), so retry later, or list what the mirror has with
`git_query` op `refs`. Nothing fetches on demand — the box has no credentials and
no network path to the forge, and a fetch belongs to the supplier. This is only
said when git reports the object does not exist; any other git failure (a
repository git refuses to open: ownership, corruption, permissions) is
`git_failed` with git's own first line, because "wait for a fetch" would hide
that fault on every read. A path that has the virtual shape but is not readable
is refused with its reason — it is never handed to the filesystem, where it would
come back as a bare "not found".

### What each file tool does on a virtual path

pi's tools are not modified: their argument handling, sorting, relativising,
limits and notices stay pi's, which is what keeps a virtual path's output shaped
like the same tool's output on disk. Only the operations underneath change.

| Tool | Virtual path |
|---|---|
| `read` | the blob at that commit; refuses a directory, submodule, excluded path or a blob over `max_file_bytes`; a symlink is refused with its target named, so the next read works |
| `ls` | the tree listing, cached per tree object — pi stats every entry, and trees are immutable |
| `find` | the recursive listing, matched by the SAME `globSync` call and options as on disk, over an in-memory filesystem of that listing |
| `grep` | pi's grep spawns ripgrep on the real filesystem, so its `execute` is wrapped: `git grep -z -n -I` with `-P` (PCRE, the closest dialect to ripgrep's), `-F`, `-i`, pi's glob semantics, context blocks, paths relative to the search path, and a streaming limit that kills git at `limit` matches |

`grep`'s mapping is held to a contract test (`code-view.test.ts`): the same
queries over the commit written out to disk (real ripgrep through pi's tool) and
over the commit itself must produce byte-identical output. pi is pinned; that test is what fails first on an
upgrade. It is skipped — with the reason printed — where `rg` is not installed.

Known, accepted differences from the same tool run over a checkout of that commit:

- PCRE is not Rust regex at the edges (lookaround works here, not in rg).
- git runs under `LC_ALL=C`: Unicode character classes and `-i` apply to ASCII
  only.
- `.ignore` files that rg would honour are not read.
- `git grep` searches a symlink's target text where rg, not following links,
  skips it.
- A blob over `max_file_bytes` is visible to `ls`/`find`/`grep` and refused only
  by `read`. `grep` with `context` reads such a file in full to print its lines,
  one `git cat-file` per matching file — linear in the number of matching files,
  which is the one operation that grows noticeably on large repositories.
  `max_file_bytes` is a hygiene limit, not an authorisation boundary.
- Symlinks: every symlink is listed as a file and `read` refuses it, naming the
  target, where a checkout would follow one.
- Result order is git's path order; rg's multi-threaded walk has none.
- A `grep` glob containing `/` is anchored at the process's cwd, not the search
  path — pi's existing behaviour on disk, reproduced on purpose.
- `export-ignore` attributes are not applied. They are archive hygiene, not an
  authorisation boundary, and git 2.39 has no `check-attr --source` to evaluate
  them against a commit without a work tree.

### `git_query`

A registry tool in its own `read_code` capability group. Reading a project's
history is a grant about that project's source, while `read_files` is every
type's baseline, so the two are selected separately. `read_code` is only useful
together with `read_files` (the SHAs it returns are read with the file tools at
`<repo>@<sha>` paths), so a selection naming it should name both. Note the split
covers the tool only: the `<repo>@<sha>` views themselves are still served by the
file tools, i.e. by `read_files`. It is offered only when the authoritative set
is non-empty at session build.

| op | Answers |
|---|---|
| `refs` | branches, tags (peeled to the commit) and MR heads (`refs/mr/<iid>`) → SHA, newest first; substring `pattern`, `limit` ≤ 200 |
| `log` | commits from `ref` (default `HEAD`, the mirror's default branch), optional `path`, `limit` ≤ 200; `search` (`-S`) and `grep` (`--grep`) each REQUIRE `path` or an explicit `limit` — they scan every commit, and that cost must be named by the caller |
| `diff` | `from` → `to`, optional `path`, `stat` |
| `show` | one commit: message, author, dates, `--stat` |
| `blame` | `path` at `ref`, optional line range; refused exactly where `read` would refuse the file |

- Every ref is validated (a SHA, or a refname from a conservative character set,
  optionally with `~N`/`^N`) and RESOLVED to a full commit SHA before the real
  command runs; the command then sees only 40-hex object names, placed after
  `--end-of-options` (blame, whose git 2.39 parser rejects that flag, relies on
  the resolution alone). A resolved name is printed as `name = <sha>` so the
  agent cites the SHA, not the branch.
- Paths are repository-relative, have no `.`/`..` segments, and follow `--` as
  `:(literal)<path>`; an excluded directory is refused as a `path` and left out
  of `diff`/`show` output.
- Output is capped at 256 KiB, cut at a line boundary and marked.
- Failures are results, not throws: `details.error: true` with a `reason` (the
  code-view refusal kinds above, `invalid_argument`, `timeout`, `git_failed`).
  Anything else — an abort, a spawn failure — propagates.

### How git is run

The agent never supplies a command line; callers build argv from validated
parts. git still reads a great deal of ambient state on its own, and several of
those inputs execute programs, so all of it is pinned for every invocation:

- argv only, never a shell; the child's environment is built from an allow-list
  (`PATH`, `LC_ALL=C`, `HOME=/tmp`, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`,
  `GIT_NO_REPLACE_OBJECTS=1`) — nothing of the box's reaches it;
- a fixed prefix overrides the repository's own config key by key:
  `--no-pager`, `safe.directory=*` (the mirrors belong to the supplier's uid),
  `gc.auto=0` and `maintenance.auto=0` (a reader must never repack a pool other
  boxes are reading over NFS), `core.fsmonitor=false` and
  `core.hooksPath=/dev/null` (both name programs), `protocol.allow=never`
  (nothing here talks to a remote);
- `GIT_NO_REPLACE_OBJECTS=1`: `refs/replace/*` would otherwise substitute one
  object for another — the SHA the agent cites would not be the content it read;
- commands that can diff run with `--no-ext-diff --no-textconv` (drivers are
  programs named by attributes/config); `log`/`show` with `--no-show-signature`
  (`log.showSignature` would run gpg); explicit formats and `--no-color`;
- a 20-second timeout, an output cap and a per-box concurrency gate (4), because
  the mirrors are on NFS and the agent decides how often to ask.
- 🔴 on timeout or abort the CALLER is settled at once, but the gate slot is
  released only when the git process has actually exited. A git blocked on a hung
  NFS mount ignores SIGKILL until the kernel releases it: waiting for its exit hung
  the tool call and made Stop useless, while freeing its slot early would let such
  processes pile up without bound. Waiting for a slot is bounded by the same
  timeout, so once every slot is held by a stuck process, reads fail with
  "git processes appear to be stuck on the code volume" instead of queuing forever.

The image carries `git` for this layer alone. It is not in the command
whitelist, and adding it there is out of scope by design: a git command line is
an argument-injection surface (`-c core.pager=…`, `--exec-path`, `--output`).

### Authorisation scope

Authorisation is per REPOSITORY, decided by the supplier's manifest and enforced
by the pod spec (a box can only open mirrors it has a mount for) plus the
authoritative-set check (for revocation). An agent bound to a repository can
read every branch, tag and MR head in its mirror, including unmerged work.
Exclusion rules shape what is served; they are not an authorisation boundary.

### Prompt

The knowledge overview gains a "Git history" section after the Code
Repositories table: the readable repositories and the addressing rule
(`<reposPath>/<name>@<sha>/…`; `git_query refs` turns a branch/MR into a SHA).
Without it the agent cannot know these paths exist, since no listing shows them,
so the rule text itself is never cut. The name list counts against the same
character budget and truncates visibly, pointing at the manifest; a Code
Repositories table before it (local mode, or a leftover directory) is unchanged
by its presence.

## The `coding` type

`coding` is the shared wire key in Runtime configuration and the Portal
type picker. Deployments upgrading from a product-specific key must migrate their
stored agent types before starting the new Runtime; no alias is provided. Keep
control-plane migrations and business prompts with the system that owns them.

A built-in agent type whose capability groups are host-configured, like
`ticket`: `AGENT_TYPES["coding"].capabilities` is `null`, the control plane's
released type definition carries the selection, and an empty delivery is refused
(`CODING_CAPABILITIES_REQUIRED`) rather than read as unrestricted. The runtime
keeps no copy of the list. This is what lets the type hold `read_code`, which no
locked type has. The mounts themselves are still decided by the manifest gate
and are available to any agent the supplier prepares.

Its built-in `defaultPrompt` states only the facts this runtime owns: the source
is read-only, reachable only through the file tools at
`.siclaw/repos/<repo>@<sha>/<path>` (paths no `ls` shows, and no shell reaches);
`git_query` op `refs` turns a branch, tag or MR into a SHA; the readable
repositories are in the "Git history" section, which may truncate, and in full in
`.siclaw/repos/.gitrepos.json`. The business prompt (what a project's
environments mean, how to find the commit one runs) is owned and released by the
control plane, so the two stay single-source.

The previous default, which described per-view directories and `.revision.json`,
is kept in `MATERIALIZED_TYPE_PROMPTS["coding"]`: a row persisted while it was the
default is recognised as the default rather than injected as an addendum that
would point the agent at a layout that no longer exists.

🔴 **A new agent type is six edits, and TypeScript catches only one of them.**
`AGENT_TYPES` is typed as `Record<AgentType, …>`, so widening the union does flag
that one — and `MATERIALIZED_TYPE_PROMPTS`. The rest are hand-written literal
comparisons that stay valid when the union grows:

| Place | On omission |
|---|---|
| `AgentType` union (`src/core/agent-types.ts`) | compile error at the registry |
| `AGENT_TYPES` | compile error |
| `MATERIALIZED_TYPE_PROMPTS` | compile error |
| `normalizeAgentType()` | silently downgrades the type to `custom` |
| `requireAgentType()` | THROWS — every session of that type fails to build |
| `portal-web/src/lib/agentTypes.ts` | the type picker cannot show it |

`requireAgentType()` is the sharp one: it is on the path of every session build
(`agent-context.ts`, `gateway/internal-api.ts`, `agentbox/local-spawner.ts`,
`portal/cli-snapshot-api.ts`) and it throws rather than degrading, so a forgotten
entry does not produce a weaker agent — it produces an agent that cannot start.
`agent-types.test.ts` now drives both functions from `Object.keys(AGENT_TYPES)`,
which turns each omission into a failing assertion that names the type.

A seventh copy used to exist in the AgentBox tools sync handler, where an unknown
`agentType` in a tool-capabilities payload THROWS and leaves the box with no
resolved tool schema at all. It is now derived from the registry rather than
re-listed; `agent-types.ts` is a dependency-free leaf, so importing it keeps that
module a leaf too.

## Scope and limitations

- Reading only. Nothing here creates, writes, prunes or quota-checks the volume,
  and the Runtime never reports on it.
- The mirrors are only ever read. A reader never runs gc/maintenance on them;
  the supplier is expected not to repack them in place either, since boxes read
  their packs over NFS.
- The mount decision is per-pod-creation — for the agent directory and for each
  git mirror alike. A running box does not gain or lose a mount when the volume
  changes underneath it; that takes a cold start. (Revoking a repository's
  history is the exception on the reading side: the box stops serving it within
  seconds, while the mount lingers — see "The authoritative set, and
  revocation".)
- A commit newer than a mirror's last fetch is unreadable until the supplier
  fetches it; there is no on-demand fetch.
- A box that cold-starts before the supplier's first manifest for its agent sees
  no code for its lifetime (see "The mount gate" (2)).
