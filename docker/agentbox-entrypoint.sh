#!/bin/bash
set -e

# ── AgentBox Entrypoint ────────────────────────────────────────────
# Runs as root (no USER directive before ENTRYPOINT).
# Fixes volume mount permissions, then drops to agentbox user.
#
# See: docs/design/security.md, Dockerfile.agentbox

# ── Validate dual-user setup (fail-fast on build error) ───────────
if ! id sandbox &>/dev/null; then
  echo "FATAL: sandbox user not found — image build error." >&2
  exit 1
fi

if ! id agentbox &>/dev/null; then
  echo "FATAL: agentbox user not found — image build error." >&2
  exit 1
fi

# The property this whole layer rests on: sandbox must hold NO credential group. If it does, every reader
# binary in the image can open the credentials and the setgid bit on kubectl is decorative — the state
# this image shipped in between 2026-04 and 2026-08. Refuse to start rather than run with the isolation
# silently absent.
# `id -nG sandbox` failing is not the same as sandbox holding no group: a missing user yields an empty
# list and every membership test below passes. Establish the user exists FIRST, so the check cannot pass
# by accident.
if ! sandbox_groups=$(id -nG sandbox 2>/dev/null); then
  echo "FATAL: cannot read sandbox's groups — the user is missing or id failed." >&2
  echo "       The isolation this checks cannot be verified, so refusing rather than assuming." >&2
  exit 1
fi
for grp in kubecred hostcred devopscred; do
  if printf '%s\n' "$sandbox_groups" | tr " " "\n" | grep -qx "$grp"; then
    echo "FATAL: sandbox is a member of $grp — credential isolation is not in effect." >&2
    echo "       Remove -G from the sandbox useradd; see docs/design/security.md §3 and ADR-010." >&2
    exit 1
  fi
done

# ── Fix volume mount permissions ──────────────────────────────────
# The main container has CAP_CHOWN + CAP_FOWNER so these succeed in
# both K8s and standalone Docker. Capabilities are dropped after
# runuser switches to the agentbox user (no security impact).

# Credentials.
#
# The parent is a TRAVERSAL POINT, not a boundary. `0751` grants `o+x` and no `o+r`, so EVERY setgid
# reader can walk through it without the parent having to name any of them, and the boundary is one
# directory further down: each credential TYPE directory is 2750 with its own group, and each
# credential file is 0640 with that group.
#
# This used to be `agentbox:kubecred 0750`, and the comment here recorded a measurement: tightening it
# to `agentbox:agentbox` locks the setgid `kubectl` out and every kubectl the agent issues fails with
# `permission denied`. That measurement stands, and it was about the MODE, not the owner — with the
# parent readable by exactly ONE credential group, a second setgid reader could not even traverse. The
# project-agent CLI (setgid `devopscred`) is that second reader, so the parent stops naming a group
# and starts granting traversal to all of them.
#
# What `o+x` gives `sandbox` is path resolution, and nothing else: it cannot list this directory (no
# `o+r`), cannot enter a type directory (2750, other=0), and cannot open a credential file (0640,
# other=0). Every one of those fails for the same reason as before — `sandbox` belongs to NO credential
# group (Dockerfile.agentbox; asserted at build time and again at startup above). Between 2026-04 and
# 2026-08 it WAS in kubecred, and that grant, not any directory mode, is what made the isolation absent.
#
# mkdir FIRST, and this is a fix, not tidiness: /app/.siclaw/credentials is an emptyDir mount, so the
# image's own type directories are SHADOWED at runtime and every chown below used to run against a
# missing path and swallow the failure in `|| true`. The verification loop after it then skipped every
# entry it was written to check, and the directories were created later by the node process at whatever
# the umask gave (0755, agentbox:agentbox). Creating them here restores both the setgid group
# inheritance and the assertions.
#
# The `-R` on the parent is gone, and stays gone: it flattened `hosts/` into kubecred as well,
# discarding the per-type split. Each type is chowned separately below.
if ! mkdir -p /app/.siclaw/credentials/clusters /app/.siclaw/credentials/hosts /app/.siclaw/credentials/devops; then
  echo "FATAL: cannot create the credential type directories under /app/.siclaw/credentials." >&2
  echo "       There is no per-type isolation to apply without them, so refusing to start." >&2
  exit 1
fi
chown agentbox:agentbox /app/.siclaw/credentials 2>/dev/null || true
chmod 0751 /app/.siclaw/credentials 2>/dev/null || true
# setgid on each type directory, so whatever is materialized into it inherits that type's group.
chown -R agentbox:kubecred /app/.siclaw/credentials/clusters 2>/dev/null || true
chmod 2750 /app/.siclaw/credentials/clusters 2>/dev/null || true
chown -R agentbox:hostcred /app/.siclaw/credentials/hosts 2>/dev/null || true
chmod 2750 /app/.siclaw/credentials/hosts 2>/dev/null || true
chown -R agentbox:devopscred /app/.siclaw/credentials/devops 2>/dev/null || true
chmod 2750 /app/.siclaw/credentials/devops 2>/dev/null || true
# Group-readable files, for the setgid readers (kubectl, siforgectl) — not for sandbox, which is in no
# such group.
find /app/.siclaw/credentials -type f -exec chmod 0640 {} \; 2>/dev/null || true

# Verify the chowns above actually took effect, rather than trusting that they did.
#
# Every one of them ends in `|| true`, which is right — a standalone Docker run without CAP_CHOWN should
# not be bricked by it — but it means the isolation can fail to apply in complete silence. The volume is
# an emptyDir, mounted root-owned, so if the chown does not land the credential tree stays world-readable
# and every child process can read it. The group guard above does NOT catch this: it checks sandbox's
# group membership, which is a property of the image, not of the directory.
#
# The realistic way to get here is a spec change, not a bug: `runAsNonRoot: true`, a restricted Pod
# Security Standard on the namespace, or CHOWN dropped from the capability list. The pod would come up
# looking healthy.
# Each type directory as well as the parent: the chowns are independent, so a partial failure can leave
# one of them root-owned and readable while the parent looks correct.
for spec in "clusters:agentbox:kubecred:2750" "hosts:agentbox:hostcred:2750" "devops:agentbox:devopscred:2750"; do
  d="${spec%%:*}"; rest="${spec#*:}"; want_own="${rest%:*}"; want_mode="${rest##*:}"
  # No `|| continue` on a missing directory any more. The mkdir -p above creates all three, so absence
  # is now a real failure rather than the normal case it used to be under the emptyDir mount — and
  # "normal case" is precisely how this loop came to assert nothing in production.
  if [ ! -d "/app/.siclaw/credentials/$d" ]; then
    echo "FATAL: /app/.siclaw/credentials/$d does not exist after mkdir -p." >&2
    echo "       The credential tree cannot be isolated per type, so refusing to start." >&2
    exit 1
  fi
  got_own="$(stat -c '%U:%G' "/app/.siclaw/credentials/$d" 2>/dev/null || echo '?:?')"
  got_mode="$(stat -c '%a' "/app/.siclaw/credentials/$d" 2>/dev/null || echo '?')"
  if [ "$got_own" != "$want_own" ] || [ "$got_mode" != "$want_mode" ]; then
    echo "FATAL: /app/.siclaw/credentials/$d is $got_own mode $got_mode, expected $want_own mode $want_mode." >&2
    echo "       One credential type is not isolated even though the parent looks correct." >&2
    exit 1
  fi
done

cred_owner="$(stat -c '%U:%G' /app/.siclaw/credentials 2>/dev/null || echo '?:?')"
cred_mode="$(stat -c '%a' /app/.siclaw/credentials 2>/dev/null || echo '?')"
if [ "$cred_owner" != "agentbox:agentbox" ] || [ "$cred_mode" != "751" ]; then
  echo "FATAL: /app/.siclaw/credentials is $cred_owner mode $cred_mode, expected agentbox:agentbox mode 751." >&2
  echo "       The permission fix did not take effect, so the credential tree is not isolated from" >&2
  echo "       child processes. The container must start as root with CAP_CHOWN/CAP_FOWNER — check for" >&2
  echo "       runAsNonRoot, a restricted PodSecurity policy, or a dropped capability." >&2
  echo "       See docs/design/security.md §3 and ADR-010." >&2
  exit 1
fi

chown -R agentbox:agentbox /app/.siclaw/skills 2>/dev/null || true
chmod 0755 /app/.siclaw/skills 2>/dev/null || true

# 🔴 user-data is the one directory here that is NOT a local emptyDir: it is a subPath on a
# shared NFS PVC, and EVERY box of an agent mounts the SAME path (by design — session history
# lives there, so a session can be picked up by another box). Two consequences that an
# unconditional `chown -R` gets badly wrong:
#
#   - It is O(agent's whole history), over NFS, one SETATTR round trip per file, and that
#     history only grows. It ran BEFORE node starts and is silent, so it was invisible from
#     every angle: it consumed the entire 60s startupProbe window, kubelet killed the
#     container, and under `restartPolicy: Never` that is permanent. The box's own startup
#     work, once it got to run, took 0.4 seconds.
#   - Boxes starting together each run it over the SAME inodes — the same idempotent work N
#     times, contending on one NFS server, while any already-serving box takes the IO hit.
#
# So the root directory's ownership IS the completion marker: correct means "this tree has
# already been claimed", and every later start is one stat.
#
# ORDER IS LOAD-BEARING — contents first, root last. `chown -R` does the opposite (root, then
# recurse), which is exactly what makes it unsafe to resume: killed midway it leaves the root
# already correct and the tree half-done, so every future start skips the repair forever. And
# "killed midway" is not hypothetical here; it is the failure this whole block is about.
#
# `-h` is not pedantry: without it chown FOLLOWS symlinks and changes the target's owner, and
# this tree holds agent-written content — one link pointing outside would let the root-owned
# entrypoint retitle a file beyond it.
#
# Numeric ids rather than names, so nothing depends on name resolution inside the container.
# 1000 is `useradd --uid 1000 agentbox` in Dockerfile.agentbox — keep in step. Both halves are
# checked: a root left at `1000:0` is not claimed, and reading only the uid would call it done.
#
# Assumes the export preserves the writer's ids. If it maps them (all_squash / anonuid) every
# file reads as wrongly-owned forever, the guard never matches, and this degenerates into the
# full walk on every start — that has to be fixed at the mount, not here.
user_data_dir=/app/.siclaw/user-data
if [ "$(stat -c '%u:%g' "$user_data_dir" 2>/dev/null || echo '')" != "1000:1000" ]; then
  if find "$user_data_dir" -xdev -mindepth 1 \( ! -uid 1000 -o ! -gid 1000 \) \
       -exec chown -h 1000:1000 {} + 2>/dev/null \
     && chown 1000:1000 "$user_data_dir" 2>/dev/null
  then
    :
  else
    # Deliberately not fatal, unlike the credential checks above. Those guard an isolation
    # property — running without it is worse than not running. This is a degradation: the
    # directory itself is world-writable (below), so the box still works, it just may not be
    # able to write some pre-existing file. Exiting here would also brick `docker run` without
    # CAP_CHOWN, which every `|| true` in this script exists to keep working.
    #
    # But it must not be SILENT — a silent chown over this directory is what made the outage
    # unreadable. Not marking the root is the other half: the repair simply runs again next
    # start.
    echo "WARNING: could not claim ownership of $user_data_dir — the box may be unable to" >&2
    echo "         write files left by an earlier version; retrying on next start." >&2
  fi
fi
# Outside the guard: O(1), idempotent, and a freshly provisioned subPath needs it before the
# box can write at all.
chmod 0777 "$user_data_dir" 2>/dev/null || true

chown -R agentbox:agentbox /app/.siclaw/config 2>/dev/null || true
chmod 0700 /app/.siclaw/config 2>/dev/null || true

# ── Drop to agentbox and exec CMD ────────────────────────────────
exec runuser -u agentbox -- "$@"
