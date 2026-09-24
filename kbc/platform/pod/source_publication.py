"""Publication-status signals for documentation-site sources.

A documentation-site archive keeps pages it does not publish: frontmatter
``hidden: true``, a site ignore file (Mintlify ``.mintignore``) or simply no
entry in the site navigation (``docs.json`` / ``mint.json``). The compiler
reads Raw bodies, so without a signal such pages compile as live product.

This module only REPORTS status. Whether unpublished content belongs in a
knowledge base is the owner's decision; nothing here excludes, drops or
re-accounts a source. The ignore file is read from disk at the site root and
is never added to the source inventory (hidden-file policy stays in
``source_kinds``).
"""

from __future__ import annotations

import fnmatch
import json
import posixpath
import re
from pathlib import Path

PAGE_EXTS = (".md", ".mdx")
SITE_CONFIGS = ("docs.json", "mint.json")
IGNORE_FILES = (".mintignore",)
_FRONTMATTER_BYTES = 4 * 1024
_CONFIG_BYTES = 2 * 1024 * 1024
_NOTE_CHARS = 200
_HIDDEN_RE = re.compile(r"^hidden\s*:\s*(?:true|yes|on)\s*(?:#.*)?$", re.IGNORECASE | re.MULTILINE)

HIDDEN = "frontmatter_hidden"
IGNORED = "site_ignore_file"
NOT_IN_NAVIGATION = "not_in_site_navigation"


def _frontmatter_hidden(path: Path) -> bool:
    try:
        with open(path, "rb") as stream:
            head = stream.read(_FRONTMATTER_BYTES).decode("utf-8", errors="replace")
    except OSError:
        return False
    head = head.lstrip("﻿")
    if not head.startswith("---"):
        return False
    end = head.find("\n---", 3)
    if end < 0:
        return False
    return bool(_HIDDEN_RE.search(head[3:end]))


def _navigation_pages(config: object) -> set[str] | None:
    """Every page reference under ``navigation``; None when there is no usable
    navigation (then "not in navigation" would be noise, not a signal). An
    object marked ``"hidden": true`` contributes nothing."""
    if not isinstance(config, dict) or "navigation" not in config:
        return None
    pages: set[str] = set()

    def walk(node: object, in_pages: bool) -> None:
        if isinstance(node, str):
            if in_pages:
                pages.add(node.strip().lstrip("/"))
            return
        if isinstance(node, list):
            for item in node:
                walk(item, in_pages)
            return
        if isinstance(node, dict):
            if node.get("hidden") is True:
                return
            for key, value in node.items():
                walk(value, key == "pages" or (in_pages and key == "page"))

    walk(config["navigation"], False)
    return pages or None


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


def _ignore_match(rel: str, pattern: str) -> bool:
    """Gitignore-style subset: a trailing ``/`` names a directory; a pattern
    with a leading or inner ``/`` is anchored at the site root, otherwise it
    matches one path segment at any depth."""
    directory = pattern.endswith("/")
    anchored = "/" in pattern.rstrip("/")
    body = pattern.strip("/")
    if not body:
        return False
    parts = rel.split("/")
    if anchored:
        depth = body.count("/") + 1
        if len(parts) < depth + (1 if directory else 0):
            return False
        return fnmatch.fnmatchcase("/".join(parts[:depth]), body)
    segments = parts[:-1] if directory else parts
    return any(fnmatch.fnmatchcase(segment, body) for segment in segments)


def publication_signals(workdir: str, sources: list[str]) -> dict[str, list[dict]]:
    """raw-relative page path → [{"signal": ..., "detail": ...}] for pages a
    documentation site marks as unpublished. Pages with no signal are absent.

    Site roots are the directories holding ``docs.json``/``mint.json`` in the
    inventory; a page belongs to its deepest enclosing site. Pages outside any
    site root only carry the frontmatter signal."""
    raw = Path(workdir) / "raw"
    roots: dict[str, set[str] | None] = {}
    for source in sources:
        if posixpath.basename(source) not in SITE_CONFIGS:
            continue
        root = posixpath.dirname(source)
        path = raw / source
        try:
            if path.stat().st_size > _CONFIG_BYTES:
                continue
            config = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        nav = _navigation_pages(config)
        merged = (roots.get(root) or set()) | (nav or set())
        roots[root] = merged or None
    ignore_rules = {
        root: [rule for name in IGNORE_FILES
               for rule in _ignore_rules(raw / root / name if root else raw / name)]
        for root in roots
    }
    out: dict[str, list[dict]] = {}
    for source in sources:
        if not source.lower().endswith(PAGE_EXTS):
            continue
        signals: list[dict] = []
        if _frontmatter_hidden(raw / source):
            signals.append({"signal": HIDDEN, "detail": "hidden: true"})
        enclosing = [r for r in roots if r == "" or source.startswith(r + "/")]
        if enclosing:
            root = max(enclosing, key=len)
            rel = source[len(root) + 1:] if root else source
            ignored, detail = False, ""
            for pattern, negated, note in ignore_rules.get(root, []):
                if _ignore_match(rel, pattern):
                    ignored, detail = (not negated), (f"{pattern} — {note}" if note else pattern)
            if ignored:
                name = posixpath.join(root, IGNORE_FILES[0]) if root else IGNORE_FILES[0]
                signals.append({"signal": IGNORED, "detail": f"{name}: {detail}"[:_NOTE_CHARS * 2]})
            nav = roots[root]
            stem = posixpath.splitext(rel)[0]
            # Snippets are included into other pages, never navigated to; the
            # site-root index is the home page whether or not navigation lists it.
            if (nav is not None and stem != "index" and "snippets" not in rel.split("/")[:-1]
                    and stem not in nav):
                signals.append({"signal": NOT_IN_NAVIGATION, "detail": ""})
        if signals:
            out[source] = signals
    return out


_LABELS_EN = {HIDDEN: "frontmatter hidden", IGNORED: "site ignore file",
              NOT_IN_NAVIGATION: "not in site navigation"}
_LABELS_ZH = {HIDDEN: "frontmatter 标记 hidden", IGNORED: "站点忽略文件",
              NOT_IN_NAVIGATION: "不在站点导航"}


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
                "these sources are marked as NOT published on their site. Compile them as usual — do not "
                "exclude them on your own; excluding is the owner's decision. But every page and index entry "
                "compiled from them must state that the source site marks this content as unpublished/hidden "
                "(quote the reason when one is given) and must not present it as a currently available product "
                "or feature:\n")
    else:
        head = ("\n\n源发布状态(由文档站自身文件机械算出):下列源在其站点标记为**未发布**。照常编译,不要自行排除——"
                "是否排除由负责人决定;但由它们编出的页面和 index 条目必须写明「源站点把这部分内容标记为未发布/隐藏」"
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
