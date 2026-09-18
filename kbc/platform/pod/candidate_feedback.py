"""Advisory page-local checks after a successful compiler write."""

from pathlib import Path

import selfcheck


def check_page(workdir, target):
    root = Path(workdir).resolve()
    try:
        rel = Path(target).relative_to(root / "candidate").as_posix()
    except ValueError:
        return None
    if Path(rel).suffix.lower() != ".md":
        return None
    text = Path(target).read_text("utf-8")
    fm, _, error = selfcheck.parse_okf_frontmatter(text)
    if selfcheck._is_reserved_page(rel):
        error = None  # Reserved-page grammar is checked by format_policy_violations.
    page = {"text": text}
    violations = selfcheck.format_policy_violations({rel: page})
    if fm and not selfcheck._is_reserved_page(rel):
        refs, derived, has_sources = selfcheck.parse_okf_sources(
            text, set(selfcheck.source_inventory(workdir)))
        if not has_sources and not derived:
            violations.append({"page": rel, "kind": "no_provenance",
                               "detail": "Declare the sources actually supporting this page."})
        body_sources, malformed = selfcheck._body_source_references(text)
        names = {Path(source).name for source in refs}
        for source in body_sources:
            if source not in refs and Path(source).name not in names:
                violations.append({"page": rel, "kind": "body_source_uncited",
                                   "detail": f"Body citation is not registered in this page: {source}"})
        for source in malformed:
            violations.append({"page": rel, "kind": "body_source_malformed",
                               "detail": f"Malformed body source reference: {source}"})
    if fm and isinstance(fm.get("sources"), list):
        for entry in fm["sources"]:
            resource = entry.get("resource") if isinstance(entry, dict) else None
            # Only explicit managed Raw references: external OKF resources are valid.
            if not isinstance(resource, str) or not resource.startswith("raw/"):
                continue
            source = root / resource
            try:
                source.resolve().relative_to(root / "raw")
            except ValueError:
                exists = False
            else:
                exists = source.is_file() and not source.is_symlink()
            if not exists:
                violations.append({"page": rel, "kind": "source_missing",
                                   "detail": f"Declared Raw source does not exist: {resource}"})
    return {"scope": "page_local", "persisted": True,
            "status": "needs_attention" if violations or error else "no_local_issues",
            "metadata_error": error,
            "issues": [{"kind": v["kind"], "detail": v["detail"][:800]} for v in violations[:12]],
            "issue_count": len(violations), "truncated": len(violations) > 12,
            "note": "The write succeeded. Fix relevant local issues in this session. "
                    "This is not a semantic, coverage, link, or publication approval; "
                    "cross-page checks still run at completion. Never infer citations from file reads."}
