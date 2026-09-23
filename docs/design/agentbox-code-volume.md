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
it creates the PVC, decides which repositories and which commits an agent may
see, writes the trees, and garbage-collects them. Nothing in this repository ever
writes to the volume, and no part of the control-plane protocol carries a "this
agent has code" field. The entire interface between the two systems is the layout
below plus one marker file.

### Volume layout

```
<volume root>/
└── agents/<agentId>/                 one directory per agent, subPath-scoped
    ├── <repo>@<view>/                a complete source tree at one commit
    ├── <repo>@<other-view>/
    └── .ready                        the supplier's completion marker
```

- `<agentId>` is sanitized with the same rule the Runtime uses for the
  `user-data` subPath: every character outside `[A-Za-z0-9._-]` becomes `_`, then
  truncated to 63 characters. This is an implicit cross-repository contract — the
  supplier writes these directory names and the Runtime mounts them, so a
  divergence in one character produces a mount pointing at a directory nobody
  fills. `k8s-spawner.test.ts` pins the rule against the `user-data` subPath so
  the two can never drift apart on this side.
- The layout is FLAT: one top-level directory per repository-and-view. Nesting
  views under a repository directory would collapse them into a single row in the
  prompt table whose file count is the sum of every view, and a `grep` for one
  symbol would match once per view.
- Only DIRECTORIES become rows of the prompt table: the scanner keeps an entry
  when it is a directory (or a symlink to one) and drops everything else. That —
  not the leading dot — is why the marker and supplier metadata (`.ready`,
  `.revision.json`, `.gitrepos.json`) stay out of it: they are FILES. A
  dot-prefixed DIRECTORY is listed like any other; the dot rule applies only
  while counting files INSIDE a tree (entries starting with `.` and
  `node_modules` are skipped there). So supplier metadata must be files, and any
  directory the supplier leaves inside `agents/<agentId>/` is presented to the
  agent as a repository.

### The ready marker

`agents/<agentId>/.ready` — not a control-plane flag — decides whether a pod gets
the mount. Three reasons, in order of how much they cost when ignored:

1. **kubelet creates a missing subPath.** A mount whose subPath does not exist
   does not fail; kubelet creates the directory on the underlying writable mount
   and the pod starts normally. The agent then sees an EMPTY directory, and an
   agent that reads no files concludes the code says nothing. Checking the marker
   is the only thing standing between "no code" and "wrong answer".
2. **A pod's mounts are decided once.** `spawn()` reuses a Running pod after
   checking only its profile and its certificate; it does not re-evaluate
   volumes. A box that comes up without the mount stays without it for its whole
   life — until its idle self-destruct, an image roll, a certificate rotation, or
   an explicit terminate. The most common sequence for a newly prepared agent
   (prepare, then immediately talk to it) is therefore also the worst one, which
   is why the supplier is expected to create the directory and the marker
   SYNCHRONOUSLY before it reports the agent ready.
3. **Two sources for one fact always diverge.** The marker already states
   "a supplier has prepared this agent"; a delivered boolean saying the same thing
   can only be inconsistent with the filesystem for some window.

A missing marker is checked twice, ~200ms apart, before the Runtime concludes the
tree is absent. The volume is NFS-backed and a negative lookup for a
just-created file can be served from the client attribute cache; given (2), being
wrong is expensive and long-lived, while the retry is paid only on the miss path
and only when a code PVC is configured at all.

A missing marker is NOT an error. The supplier is an independent system and "not
prepared" is the normal steady state of every agent that has no source
configured. The box spawns without the mount and the Runtime logs why.

### What the agent sees

The mount path is `/app/.siclaw/repos` — the configured `paths.reposDir` — and
that choice is what makes this feature invisible inside the box:

- it is already in the file tools' read whitelist;
- its top-level directories are already scanned into the system prompt as the
  "Code Repositories" table;
- the AgentBox entrypoint chowns `credentials`, `skills`, `user-data` and
  `config` and deliberately does NOT touch `repos`, so a read-only mount there
  cannot fail its `set -e` startup.

The trees are readable but not a working copy: no `.git`, no shell access, and
`readOnly: true` on the mount. The agent reads them with `read`, `grep`, `find`
and `ls`.

### Permissions

The supplier writes directories `0755` and files `0644`; the box process (uid
1000) reads through the other bits.

🔴 **Do not add `fsGroup`.** kubelet chowns a volume RECURSIVELY at mount time.
On an NFS-backed tree of hundreds of thousands of files that is one SETATTR per
file; it consumes the entire `startupProbe` window and the container is killed
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
`/app/.siclaw/code-root`, which is how the Runtime reads the markers. That path
is never handed to an AgentBox; each box receives a subPath-scoped mount of its
own `agents/<agentId>/` subtree and can reach neither another agent's trees nor
the volume root.

There is no paired `enabled` policy flag and nothing arrives per-agent over the
control-plane protocol — see "The ready marker" (3). The chart never provisions
the PVC.

**With the claim name unset, pods are byte-identical to a deployment that never
had this feature**, and the Runtime does not touch the filesystem: the claim-name
check short-circuits before the marker lookup.

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
it is counted against the same budget rather than exempted from it. Suppliers are
still expected to cap the number of views per agent — a visible truncation is a
cheap second step, not a substitute for a list that fits.

## Git layer

The flat trees are two commits per repository (`<repo>@latest`, `<repo>@<env>`).
Any other commit — an MR head, the commit a failed build ran on, a side branch —
is read in place from the supplier's bare mirrors, through the same four file
tools, at a path that does not exist on disk:

```
code volume (supplier-owned)                      AgentBox
┌──────────────────────────────────┐    ┌─────────────────────────────────────────┐
│ agents/<agentId>/                │───▶│ /app/.siclaw/repos/         (reposDir)  │
│   <repo>@<view>/  .ready         │    │   <repo>@<view>/   physical trees       │
│   .gitrepos.json  (manifest)     │    │   <repo>@<sha>/    virtual, never on    │
│                                  │    │                    disk, never in `ls`  │
│ mirrors/<host>/<path>.git  ──────┼───▶│ /app/.siclaw/gitrepos/<name>.git        │
│   (one subPath mount per repo)   │    │   (gitReposDir, read-only)              │
└──────────────────────────────────┘    └──────────────┬──────────────────────────┘
                                                       │ argv-only git
                                   read / ls / find / grep  +  git_query
```

It is additive: with no manifest, or a supplier that has not adopted it, every
pod and every file-tool result is what it was before.

### The manifest

`agents/<agentId>/.gitrepos.json`, written by the supplier next to
`.revision.json` (a FILE, so it never becomes a prompt-table row):

```json
{"version": 1, "updated_at": "…",
 "repos": [{"name": "app", "host": "gitlab.x", "path": "grp/app",
            "bare": "mirrors/gitlab.x/grp/app.git"}],
 "rules": {"exclude_dirs": ["node_modules", "vendor", "dist", "target"],
           "max_file_bytes": 5242880}}
```

- `name` is one path segment (`[A-Za-z0-9._-]{1,63}`): it is both the mount
  directory `<name>.git` and the first half of `<name>@<sha>`, spelled exactly
  like the repository half of the supplier's physical view names.
- `bare` is relative to the VOLUME root and must be `mirrors/<host>/…/<x>.git`.
  The Runtime never derives it: the pool's path rule is the supplier's, and a
  second copy of it here would be a second thing to keep in step.
- `rules` is the supplier's own exclusion list and file-size limit — the ones
  its flat trees were exported with — serialised rather than re-typed here, so
  a virtual view hides exactly what a physical one lacks.
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

### The second kind of mount

After the `.ready` gate passes (and only then — "no claim" and "no marker" stay
byte-identical to before), the spawner reads the manifest from its own view of
the whole volume and adds one mount per surviving entry:

```
{ name: "code", subPath: <bare>, mountPath: /app/.siclaw/gitrepos/<name>.git, readOnly: true }
```

- Same PVC, same volume entry: no second claim, and the two 🔴 rules above hold
  unchanged — `readOnly` on the mount, never the source; no `fsGroup`.
- Each entry is checked on disk before it becomes a mount: `realpath` must land
  inside `mirrors/` (a symlink planted on the volume must not turn a subPath
  into a window onto another agent's state), and `<bare>/HEAD` must exist —
  kubelet CREATES a missing subPath, the same trap `.ready` exists for.
- Failure is contained, not fail-fast: a missing manifest mounts nothing
  (the normal state of a supplier without the git layer); an unusable one is
  logged and mounts nothing, but the pod still spawns WITH its trees. The
  manifest is another system's output, and refusing the pod would take away the
  physical views as well — the one part that is fine.
- Mount decisions are per pod creation, like the trees: a repository granted
  while a box runs becomes readable in the next cold start.

`/app/.siclaw/gitrepos` is `config.paths.gitReposDir` (`SICLAW_GITREPOS_DIR`),
deliberately not under `reposDir`: that directory is the supplier's read-only
mount and is scanned into the prompt, so nothing of the Runtime's may live in it.

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
| manifest present but unusable | nothing is readable, and why; physical views unaffected |
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
NOT exist on disk (a physical tree always wins), `<hex>` is 7–40 hex characters
in either case (a SHA copied from a UI may be upper-case; refusing it would fall
through to the filesystem as a reasonless "not found"), and `<name>` is in the
authoritative set. Branches, tags and MR names are never
accepted there:

- a physical view is `<repo>@<env>`; accepting symbolic names would give one
  spelling two meanings;
- a branch moves, so a conclusion drawn from `app@main` could not be reproduced
  an hour later. Every conclusion is anchored to an immutable commit.

Symbolic refs are turned into SHAs by `git_query refs`. A short SHA is expanded
and an ambiguous one refused; a SHA the mirror does not have is reported as
unreachable, with code-mcp (fetch by SHA) as the next step — but only when git
says the object does not exist. Any other git failure (a repository git refuses
to open: ownership, corruption, permissions) is reported as `git_failed` with
git's own first line, because calling it "unreachable" would send the agent to
code-mcp on every read and hide the fault. A path that has the
virtual shape but is not readable is refused with its reason — it is never
handed to the filesystem, where it would come back as a bare "not found".

### What each file tool does on a virtual path

pi's tools are not modified: their argument handling, sorting, relativising,
limits and notices stay pi's, which is what keeps a virtual view's output shaped
like a physical one's. Only the operations underneath change.

| Tool | Virtual path |
|---|---|
| `read` | the blob at that commit; refuses a directory, submodule, excluded path or a blob over `max_file_bytes`; a symlink is refused with its target named, so the next read works |
| `ls` | the tree listing, cached per tree object — pi stats every entry, and trees are immutable |
| `find` | the recursive listing, matched by the SAME `globSync` call and options as the physical tree, over an in-memory filesystem of that listing |
| `grep` | pi's grep spawns ripgrep on the real filesystem, so its `execute` is wrapped: `git grep -z -n -I` with `-P` (PCRE, the closest dialect to ripgrep's), `-F`, `-i`, pi's glob semantics, context blocks, paths relative to the search path, and a streaming limit that kills git at `limit` matches |

`grep`'s mapping is held to a contract test: the same queries over a physical
tree (real ripgrep through pi's tool) and the equivalent commit must produce
byte-identical output. pi is pinned; that test is what fails first on an
upgrade. It is skipped — with the reason printed — where `rg` is not installed.

Known, accepted differences from a physical view:

- PCRE is not Rust regex at the edges (lookaround works here, not in rg).
- git runs under `LC_ALL=C`: Unicode character classes and `-i` apply to ASCII
  only.
- `.ignore` files that rg would honour are not read.
- `git grep` searches a symlink's target text where rg, not following links,
  skips it.
- A blob over `max_file_bytes` is visible to `ls`/`find`/`grep` and refused only
  by `read` (the flat trees omit such files entirely). `grep` with `context`
  reads such a file in full to print its lines. `max_file_bytes` is a hygiene
  limit, not an authorisation boundary, so this is accepted.
- Symlinks: a physical tree keeps safe symlinks, and `ls` follows one to a
  directory (`dir/`) and `read` reads its target. A virtual view lists every
  symlink as a file and `read` refuses it, naming the target. The flat tree also
  drops symlinks that point outside the tree; a virtual view still lists them.
- Result order is git's path order; rg's multi-threaded walk has none.
- A `grep` glob containing `/` is anchored at the process's cwd, not the search
  path — pi's existing behaviour on physical trees, reproduced on purpose.
- `export-ignore` attributes are not applied. They are archive hygiene, not an
  authorisation boundary, and git 2.39 has no `check-attr --source` to evaluate
  them against a commit without a work tree. A virtual view may therefore show
  files its physical counterpart lacks.

### `git_query`

A registry tool in the `read_files` capability group — history is useless
without the file tools that read the SHAs it returns, and vice versa. It is
offered only when the authoritative set is non-empty at session build.

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
character budget and truncates visibly, pointing at the manifest; the physical
table before it is unchanged by its presence.

## The `coding` type

`coding` is the shared wire key in Runtime configuration and the Portal
type picker. Deployments upgrading from a product-specific key must migrate their
stored agent types before starting the new Runtime; no alias is provided. Keep
control-plane migrations and business prompts with the system that owns them.

A built-in agent type whose capability set is byte-identical to `sre`. This type
exists because the control plane wants to manage one fleet's prompt and lifecycle
separately, not because the mount needs different tools — the mount is decided by
the ready marker and is available to any agent the supplier prepares.

Its built-in `defaultPrompt` states only the three facts this runtime owns: the
trees are a read-only snapshot rather than a checkout, they are reachable only
through the file tools, and `.siclaw/repos/.revision.json` — not the truncating
prompt table — is the authoritative listing of what is mounted. The business
prompt (what a project's views mean, how to compare them) is owned and released
by the control plane, so the two stay single-source.

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
- The mount decision is per-pod-creation — for the trees and for each git
  mirror alike. A running box does not gain or lose a mount when the volume
  changes underneath it; that takes a cold start. (Revoking a repository's
  history is the exception on the reading side: the box stops serving it within
  seconds, while the mount lingers — see "The authoritative set, and
  revocation".)
- The trees carry no freshness signal that this repository interprets. Whatever
  a view's directory name means, and how stale it is, is the supplier's contract
  with its own users.
