"""Read-only, revision-bound navigation of the current Candidate tree.

Recommendations are entry points, never a read boundary or proof of coverage.
The durable compilation state remains the recovery authority.
"""

import hashlib
import json
from pathlib import Path

import selfcheck

MAX_RESULT_CHARS = 24_000


def _pages(workdir):
    root = Path(workdir).resolve() / "candidate"
    pages = {}
    digest = hashlib.sha256()
    if root.is_symlink():
        raise ValueError("Candidate root must not be a symbolic link")
    managed = set(selfcheck.source_inventory(workdir))
    for path in sorted(root.rglob("*.md")):
        if any(p.is_symlink() for p in [path, *path.parents] if p != root.parent):
            raise ValueError("Candidate navigation refuses symbolic links")
        data = path.read_bytes()
        rel = path.relative_to(root).as_posix()
        digest.update(rel.encode() + b"\0" + hashlib.sha256(data).digest())
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            pages[rel] = {"title": rel, "description": "", "sources": [], "search_text": "",
                          "error": "Page is not valid UTF-8; inspect and repair its source encoding.",
                          "sha256": hashlib.sha256(data).hexdigest()}
            continue
        fm, body, error = selfcheck.parse_okf_frontmatter(text)
        if selfcheck._is_reserved_page(rel):
            error = None
        fm = fm or {}
        refs, _, _ = selfcheck.parse_okf_sources(text, managed)
        source_errors = [v["detail"] for v in selfcheck.format_policy_violations({rel: {"text": text}})
                         if v["kind"] == "okf_sources"]
        error = error or (source_errors[0] if source_errors else None)
        pages[rel] = {
            "title": str(fm.get("title") or rel)[:300],
            "description": str(fm.get("description") or "")[:600],
            "sources": refs, "search_text": text, "error": error,
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    return pages, digest.hexdigest()


def lookup(workdir, *, sources=None, query=None, offset=0, limit=20, revision=None):
    """Exact source lookup or literal full-page search, with explicit pagination."""
    if (isinstance(offset, bool) or not isinstance(offset, int) or offset < 0
            or isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50):
        raise ValueError("offset must be nonnegative; limit must be between 1 and 50")
    if sources is not None and (not isinstance(sources, list)
                               or any(not isinstance(s, str) or not s for s in sources)):
        raise ValueError("sources must contain nonempty source paths")
    if query is not None and (not isinstance(query, str) or not query or len(query) > 500):
        raise ValueError("query must be a nonempty literal string of at most 500 characters")
    pages, current = _pages(workdir)
    if (revision is not None and revision != current) or (offset and revision is None):
        return {"revision": current, "restart_required": True,
                "reason": "Candidate changed or pagination has no revision; restart at offset 0."}
    wanted = {selfcheck._norm_source_entry(s) for s in sources or []}
    needle = query.casefold() if query else None
    rows = []
    for path, page in pages.items():
        matching = sorted(wanted.intersection(page["sources"]))
        if wanted and not matching:
            continue
        haystack = path + "\n" + page["search_text"]
        if needle and needle not in haystack.casefold():
            continue
        row = {"path": "candidate/" + path, "title": page["title"],
               "description": page["description"], "sha256": page["sha256"],
               "sources": page["sources"][:20], "source_count": len(page["sources"]),
               "sources_truncated": len(page["sources"]) > 20,
               "matching_sources": matching[:20], "matching_source_count": len(matching),
               "matching_sources_truncated": len(matching) > 20}
        if page["error"]:
            row["metadata_error"] = page["error"]
        if needle:
            start = max(0, haystack.casefold().find(needle) - 80)
            row["excerpt"] = haystack[start:start + 600]
        # Source declarations can be much larger than navigation itself. Leave
        # their exact bytes in the page rather than returning a huge tool result.
        if len(json.dumps(row, ensure_ascii=False)) > 6000:
            row.update(sources=[], sources_truncated=bool(page["sources"]),
                       matching_sources=[], matching_sources_truncated=bool(matching))
        rows.append(row)
    selected = []
    size = 0
    for row in rows[offset:offset + limit]:
        cost = len(json.dumps(row, ensure_ascii=False))
        if selected and size + cost > MAX_RESULT_CHARS:
            break
        selected.append(row)
        size += cost
    more = offset + len(selected) < len(rows)
    return {"revision": current, "restart_required": False, "total": len(rows),
            "pages": selected, "next_offset": offset + len(selected) if more else None,
            "truncated": more,
            "metadata_issue_count": sum(bool(p["error"]) for p in pages.values()),
            "metadata_issue_pages": [p for p, v in pages.items() if v["error"]][:12],
            "note": "Navigation only; read page contents to assess relevance and claims. "
                    "Malformed metadata may omit source matches; inspect reported issue pages. "
                    "Other Candidate and permitted Raw files remain readable/searchable."}


def handoff(workdir, sources):
    result = lookup(workdir, sources=sources, limit=12)
    root = Path(workdir) / "candidate" / "index.md"
    outline = []
    preview = ""
    body = ""
    if root.is_file():
        # Preserve the author's actual topic structure, rather than invent a summary.
        _, body, _ = selfcheck.parse_okf_frontmatter(root.read_text("utf-8"))
        preview = body[:2000]
        outline = [line for line in selfcheck._markdown_prose(body).splitlines()
                   if line.startswith("#")]
    text = "\n".join(outline)
    return json.dumps({"candidate_revision": result["revision"],
                       "index_preview": preview, "index_preview_truncated": len(body) > 2000,
                       "index_headings": text[:6000], "index_headings_truncated": len(text) > 6000,
                       "overview_note": "Headings are navigation, not a full library summary. "
                           "Read index.md or relevant pages whenever more context is needed.",
                       "same_source_pages": result}, ensure_ascii=False)
