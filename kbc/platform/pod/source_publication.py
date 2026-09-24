"""Publication-status signals for documentation-site sources.

A documentation-site archive can keep pages its site does not publish at all:
Mintlify builds nothing listed in the site ignore file (``.mintignore``, which
follows ``.gitignore`` syntax). The compiler reads Raw bodies, so without a
signal such pages compile as live product.

Only the ignore file is evidence of "not published". A page that is hidden
(frontmatter ``hidden: true``) or simply absent from the navigation
(``docs.json`` / ``mint.json``) is still published: anyone with its URL can
open it, it is only left out of the sidebar and, by default, search. Those
states are deliberately not reported.

This module only REPORTS status. Whether unpublished content belongs in a
knowledge base is the owner's decision; nothing here excludes, drops or
re-accounts a source. The ignore file is read from disk at the site root and
is never added to the source inventory (hidden-file policy stays in
``source_kinds``).
"""

from __future__ import annotations

import posixpath
import re
from pathlib import Path

PAGE_EXTS = (".md", ".mdx")
SITE_CONFIGS = ("docs.json", "mint.json")
IGNORE_FILES = (".mintignore",)
_NOTE_CHARS = 200

IGNORED = "site_ignore_file"


def _ignore_rules(path: Path) -> list[tuple[str, bool, str]]:
    """(pattern, negated, preceding comment) in file order."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    rules: list[tuple[str, bool, str]] = []
    note = ""
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            note = ""
            continue
        if line.startswith("#"):
            note = line.lstrip("#").strip()[:_NOTE_CHARS]
            continue
        negated = line.startswith("!")
        rules.append((line[1:] if negated else line, negated, note))
    return rules


def _ignore_regex(body: str) -> re.Pattern[str]:
    """Translate a gitignore glob (leading/trailing ``/`` already removed) to a
    regex over a ``/``-joined path: ``**`` spans directories, ``*`` and ``?``
    stay within one segment, ``[...]`` is a character class."""
    out: list[str] = []
    i, n = 0, len(body)
    while i < n:
        if body.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif body.startswith("/**", i) and i + 3 == n:
            out.append("/.*")
            i += 3
        elif body.startswith("**", i):
            out.append(".*")
            i += 2
        elif body[i] == "*":
            out.append("[^/]*")
            i += 1
        elif body[i] == "?":
            out.append("[^/]")
            i += 1
        elif body[i] == "[" and "]" in body[i + 2:]:
            close = body.index("]", i + 2)
            chars = body[i + 1:close]
            if chars.startswith("!"):
                chars = "^" + chars[1:]
            out.append("[" + chars.replace("\\", "\\\\") + "]")
            i = close + 1
        else:
            out.append(re.escape(body[i]))
            i += 1
    return re.compile("".join(out))


def _pattern_matches(path: str, is_dir: bool, pattern: str) -> bool:
    """Whether one gitignore pattern matches this exact path: a trailing ``/``
    matches directories only; a pattern with a leading or inner ``/`` is
    anchored at the site root, otherwise it matches at any depth."""
    if pattern.endswith("/") and not is_dir:
        return False
    body = pattern.strip("/")
    if not body:
        return False
    if "/" not in pattern.rstrip("/"):
        body = "**/" + body
    return _ignore_regex(body).fullmatch(path) is not None


def _ignored_by(rel: str, rules: list[tuple[str, bool, str]]) -> tuple[str, str] | None:
    """(pattern, note) of the rule that ignores ``rel``, or None.

    Gitignore order: each directory on the way down is decided first, by the
    last rule that matches it. Once a directory is ignored nothing beneath it
    can be re-included, so ``drafts/`` followed by ``!drafts/keep.mdx`` still
    ignores the file. Otherwise the last rule matching the file decides."""
    parts = rel.split("/")
    for depth in range(1, len(parts) + 1):
        path, is_dir = "/".join(parts[:depth]), depth < len(parts)
        decided: tuple[str, bool, str] | None = None
        for rule in rules:
            if _pattern_matches(path, is_dir, rule[0]):
                decided = rule
        if decided is not None and not decided[1]:
            return decided[0], decided[2]
    return None


def publication_fingerprint(workdir: str, sources: list[str]) -> int:
    """Changes whenever a publication signal could: a source path or a site
    ignore file (outside the inventory, so its size/mtime is read here)."""
    raw = Path(workdir) / "raw"
    stamps: list[tuple] = []
    roots = {posixpath.dirname(s) for s in sources if posixpath.basename(s) in SITE_CONFIGS}
    for rel in (posixpath.join(root, name) if root else name for root in sorted(roots) for name in IGNORE_FILES):
        try:
            st = (raw / rel).stat()
            stamps.append((rel, st.st_mtime_ns, st.st_size))
        except OSError:
            stamps.append((rel, None, None))
    return hash((tuple(sources), tuple(stamps)))


def publication_signals(workdir: str, sources: list[str]) -> dict[str, list[dict]]:
    """raw-relative page path → [{"signal": ..., "detail": ...}] for pages their
    documentation site does not publish. Pages with no signal are absent.

    Site roots are the directories holding ``docs.json``/``mint.json`` in the
    inventory; a page belongs to its deepest enclosing site, whose ignore file
    decides. Pages outside any site root carry no signal."""
    raw = Path(workdir) / "raw"
    roots = sorted({posixpath.dirname(s) for s in sources if posixpath.basename(s) in SITE_CONFIGS})
    ignore_rules = {
        root: [rule for name in IGNORE_FILES
               for rule in _ignore_rules(raw / root / name if root else raw / name)]
        for root in roots
    }
    out: dict[str, list[dict]] = {}
    for source in sources:
        if not source.lower().endswith(PAGE_EXTS):
            continue
        enclosing = [r for r in roots if r == "" or source.startswith(r + "/")]
        if not enclosing:
            continue
        root = max(enclosing, key=len)
        rel = source[len(root) + 1:] if root else source
        hit = _ignored_by(rel, ignore_rules[root])
        if hit is None:
            continue
        pattern, note = hit
        name = posixpath.join(root, IGNORE_FILES[0]) if root else IGNORE_FILES[0]
        detail = f"{name}: {pattern} — {note}" if note else f"{name}: {pattern}"
        out[source] = [{"signal": IGNORED, "detail": detail[:_NOTE_CHARS * 2]}]
    return out


_LABELS_EN = {IGNORED: "site ignore file"}
_LABELS_ZH = {IGNORED: "站点忽略文件"}


def _describe(signals: list[dict], en: bool) -> str:
    labels = _LABELS_EN if en else _LABELS_ZH
    parts = []
    for item in signals:
        label = labels.get(item.get("signal"), str(item.get("signal")))
        detail = item.get("detail") or ""
        parts.append(f"{label} ({detail})" if detail and item.get("signal") == IGNORED else label)
    return "; ".join(parts)


def publication_notice(signals: dict[str, list[dict]], paths: list[str] | None = None,
                       en: bool = True, limit: int = 20) -> str:
    """Bounded model-facing notice for the flagged pages among ``paths`` (all
    flagged pages when None). Empty string when nothing is flagged."""
    selected = sorted(p for p in (signals if paths is None else paths) if p in signals)
    if not selected:
        return ""
    lines = [f"- {p}: {_describe(signals[p], en)}" for p in selected[:limit]]
    if len(selected) > limit:
        more = len(selected) - limit
        lines.append(f"- … {more} more" if en else f"- …另有 {more} 个")
    if en:
        head = ("\n\nSource publication status (computed from the documentation site's own files): "
                "their site's ignore file excludes these sources, so the site does not publish them. Compile "
                "them as usual — do not exclude them on your own; excluding is the owner's decision. But every "
                "page and index entry compiled from them must state that the source site does not publish this "
                "content (quote the reason when one is given) and must not present it as a currently available "
                "product or feature:\n")
    else:
        head = ("\n\n源发布状态(由文档站自身文件机械算出):下列源被其站点的忽略文件排除,站点**不发布**它们。照常编译,"
                "不要自行排除——是否排除由负责人决定;但由它们编出的页面和 index 条目必须写明「源站点不发布这部分内容」"
                "(有原因就引用原因),不得把它写成当前可用的产品或功能:\n")
    return head + "\n".join(lines)


def publication_summary(signals: dict[str, list[dict]], en: bool = True, limit: int = 12) -> list[str]:
    """Directory-level summary lines for the final review (bounded)."""
    groups: dict[str, int] = {}
    for path in signals:
        folder = posixpath.dirname(path)
        groups[folder] = groups.get(folder, 0) + 1
    ordered = sorted(groups.items(), key=lambda kv: (-kv[1], kv[0]))
    root = "(root)" if en else "(根目录)"
    lines = [f"   - {folder + '/' if folder else root} ({count})" for folder, count in ordered[:limit]]
    if len(ordered) > limit:
        more = len(ordered) - limit
        lines.append(f"   - … {more} more folder(s)" if en else f"   - …另有 {more} 个目录")
    return lines
