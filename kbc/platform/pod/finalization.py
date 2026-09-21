"""Machine-owned, content-bound units for resumable batch finalization.

This ledger records completed judgment, not a second copy of Candidate. Model
workers retain whole-library reads; their observed mutable read dependencies
invalidate receipts conservatively when later work changes those inputs.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

import yaml

VERSION = 1
MAX_PAGES = 6
MAX_BYTES = 64 * 1024
MAX_PASSES = 3
MAX_UNITS = 4096
KINDS = {"duplicates", "orphans", "semantic", "catalog", "introduction", "notes"}
STATUSES = {"pending", "running", "done", "split"}
CONTROL_PATHS = {
    "authoring/BATCH_PLAN.json", "authoring/COMPILATION_STATE.json",
    "authoring/manifest.yaml", "authoring/SOURCES_INVENTORY.json",
}


class FinalizationError(RuntimeError):
    pass


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), default=str).encode()).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def page_fingerprint(text: str) -> str:
    # Producer timestamps and mechanical attribution markers do not change a
    # semantic claim. Resource/locator, title, labels and body changes still do.
    body = text.replace("\r\n", "\n")
    metadata = None
    source_resources = {}
    declared_resources = set()
    match = re.match(r"\A---\n(.*?)\n---(?:\n|$)", body, re.S)
    if match:
        try:
            metadata = yaml.safe_load(match[1])
        except yaml.YAMLError:
            return digest(body)
        if isinstance(metadata, dict):
            metadata = dict(metadata)
            metadata.pop("generated", None)
            sources = metadata.get("sources")
            if isinstance(sources, list):
                normalized = []
                for source in sources:
                    resource = source.get("resource") if isinstance(source, dict) else source
                    if isinstance(resource, str) and resource:
                        declared_resources.add(resource)
                        if isinstance(source, dict) and isinstance(source.get("id"), str):
                            source_resources[source["id"]] = resource
                        normalized.append({k: v for k, v in source.items() if k != "id"}
                                          if isinstance(source, dict) else source)
                    else:
                        normalized.append(source)
                metadata["sources"] = normalized
            body = body[match.end():]
    def attribution(marker):
        try:
            value = json.loads(marker[1])
            refs = value.get("sources")
            if not isinstance(refs, list) or not all(isinstance(ref, str) for ref in refs):
                return marker[0]
            resources = sorted({source_resources.get(ref, ref) for ref in refs})
            # A generated marker repeating page-level provenance is equivalent
            # to the implicit association. A changed subset is substantive.
            if resources and set(resources) == declared_resources:
                return ""
            return "<!-- evidence-resources " + json.dumps(resources, ensure_ascii=False) + " -->\n"
        except (ValueError, AttributeError):
            return marker[0]
    body = re.sub(r"^<!-- okf:evidence (.*?)-->\s*\n?", attribution, body, flags=re.M)
    try:
        return digest([metadata, body.strip()])
    except (TypeError, ValueError):
        # Keep malformed metadata observable to the ordinary lint/repair path;
        # fingerprint its exact bytes instead of blocking that repair on hashing.
        return digest(text)


def snapshot(workdir: str) -> dict[str, str]:
    root = Path(workdir) / "candidate"
    pages = {p.relative_to(root).as_posix(): page_fingerprint(p.read_text(encoding="utf-8"))
             for p in sorted(root.rglob("*.md")) if p.is_file()}
    introduction = root / ".library-introduction.json"
    value = None
    if introduction.is_file():
        value = introduction.read_text(encoding="utf-8")
        try:
            value = json.loads(value)
        except ValueError:
            pass
    # Always include the output slot: creating routing metadata must not
    # invalidate unrelated page receipts through directory membership alone.
    pages[".library-introduction.json"] = digest(value)
    return pages


def input_identity(workdir: str) -> str:
    root = Path(workdir)
    manifest = root / "authoring/manifest.yaml"
    if manifest.is_file():
        return hashlib.sha256(manifest.read_bytes()).hexdigest()
    # Legacy/test workspaces may have no manifest. Hash their actual frozen
    # bytes once per entry, never silently substitute current platform sources.
    files = {}
    for path in sorted((root / "raw").rglob("*")):
        if path.is_file():
            sha = hashlib.sha256()
            with path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    sha.update(chunk)
            files[path.relative_to(root / "raw").as_posix()] = sha.hexdigest()
    return digest(files)


def context_identity(workdir: str) -> str:
    root = Path(workdir) / "authoring"
    files = {}
    for name in ("BRIEF.json", "INTENT.md", "RESOLUTIONS.json", "EXCLUSIONS.json"):
        path = root / name
        if path.is_file():
            text = path.read_text(encoding="utf-8")
            if name.endswith(".json"):
                try:
                    text = json.loads(text)
                except ValueError:
                    pass  # Hash the malformed bytes; the ledger checker reports them.
            files[name] = text
    return digest(files)


def _path(value) -> bool:
    return (isinstance(value, str) and bool(value) and len(value) <= 4096
            and not PurePosixPath(value).is_absolute()
            and ".." not in PurePosixPath(value).parts and "\\" not in value)


def validate(ledger: dict) -> None:
    if not isinstance(ledger, dict) or type(ledger.get("version")) is not int or ledger.get("version") != VERSION:
        raise FinalizationError("unsupported finalization ledger version")
    if not re.fullmatch(r"[a-f0-9]{64}", str(ledger.get("input_identity", ""))):
        raise FinalizationError("finalization input identity is missing")
    if not isinstance(ledger.get("stage"), str) or ledger.get("stage") not in {"review", "ledger", "media", "complete", "paused"}:
        raise FinalizationError("invalid finalization stage")
    for field in ("split_count", "passes", "note_sequence"):
        if type(ledger.get(field, 0)) is not int or ledger.get(field, 0) < 0:
            raise FinalizationError("invalid finalization counter")
    for name in ("ledger_work", "media_work"):
        work = ledger.get(name, {})
        if not isinstance(work, dict) or any(type(work.get(k, 0)) is not int or work.get(k, 0) < 0 for k in ("used", "limit")):
            raise FinalizationError("invalid finalization repair budget")
    for name in ("ledger_signature", "media_signature"):
        if name in ledger and not re.fullmatch(r"[a-f0-9]{64}", str(ledger[name])):
            raise FinalizationError("invalid finalization quality receipt")
    units = ledger.get("units")
    if not isinstance(units, list) or len(units) > MAX_UNITS:
        raise FinalizationError("invalid finalization unit inventory")
    ids = set()
    by_id = {}
    for unit in units:
        if not isinstance(unit, dict) or not re.fullmatch(r"f_[a-z]+_[a-f0-9]{16}", str(unit.get("id", ""))):
            raise FinalizationError("invalid finalization unit identity")
        if (unit["id"] in ids or not isinstance(unit.get("kind"), str) or unit.get("kind") not in KINDS
                or not isinstance(unit.get("status"), str) or unit.get("status") not in STATUSES):
            raise FinalizationError("duplicate or invalid finalization unit")
        targets = unit.get("targets")
        if not isinstance(targets, list) or len(targets) > MAX_UNITS or not all(_path(p) for p in targets) or len(set(targets)) != len(targets):
            raise FinalizationError("invalid finalization responsibility")
        if "membership_sensitive" in unit and type(unit["membership_sensitive"]) is not bool:
            raise FinalizationError("invalid directory dependency receipt")
        reads = unit.get("reads", [])
        if reads not in ("all", "content") and (not isinstance(reads, list) or not all(_path(p) for p in reads)):
            raise FinalizationError("invalid finalization dependencies")
        if type(unit.get("attempts", 0)) is not int or unit.get("attempts", 0) < 0:
            raise FinalizationError("invalid finalization attempt count")
        if unit["status"] == "done" and not all(re.fullmatch(r"[a-f0-9]{64}", str(unit.get(key, ""))) for key in ("dependency_digest", "context", "membership")):
            raise FinalizationError("completed finalization unit has no receipt")
        ids.add(unit["id"])
        by_id[unit["id"]] = unit
    for unit in units:
        if unit["status"] != "split":
            continue
        child_ids = unit.get("children", [])
        if not isinstance(child_ids, list) or len(child_ids) != 2 or not all(isinstance(i, str) and i != unit["id"] for i in child_ids):
            raise FinalizationError("invalid finalization split links")
        children = [by_id.get(i) for i in child_ids]
        if len(children) != 2 or any(child is None or child.get("parent") != unit["id"] or child["kind"] != unit["kind"] for child in children):
            raise FinalizationError("invalid finalization split")
        subjects = [p for child in children for p in child["targets"]]
        if any(not child["targets"] for child in children) or len(subjects) != len(set(subjects)) or set(subjects) != set(unit["targets"]):
            raise FinalizationError("finalization split lost or duplicated responsibility")


def ensure(plan: dict, workdir: str) -> dict:
    identity = input_identity(workdir)
    ledger = plan.get("finalization")
    if ledger is None:
        ledger = {"version": VERSION, "input_identity": identity, "units": [],
                  "stage": "review", "split_count": 0, "passes": 0}
        plan["finalization"] = ledger
    validate(ledger)
    if ledger["input_identity"] != identity:
        raise FinalizationError("frozen input changed under finalization")
    # A saved running unit has no completion certificate and is safe to retry.
    for unit in ledger["units"]:
        if unit["status"] == "running":
            unit["status"] = "pending"
    ledger.pop("current_unit", None)
    return ledger


def add(ledger: dict, kind: str, targets: list[str], **extra) -> dict:
    targets = sorted(set(targets))
    identity = [kind, targets, extra.get("notes", ""), extra.get("sequence", 0)]
    uid = "f_" + kind + "_" + digest(identity)[:16]
    existing = next((u for u in ledger["units"] if u["id"] == uid), None)
    # Preserve receipts from older producers, whose IDs omitted the parent,
    # only when they belong to this same responsibility. Regrouped orphans can
    # otherwise share a child with a different split and corrupt the graph.
    parent = extra.get("parent")
    if existing is not None and existing.get("parent") == parent:
        return existing
    if parent is not None or existing is not None:
        uid = "f_" + kind + "_" + digest(identity + [parent])[:16]
        existing = next((u for u in ledger["units"] if u["id"] == uid), None)
        if existing is not None:
            return existing
    if len(ledger["units"]) >= MAX_UNITS:
        raise FinalizationError("finalization unit bound exceeded")
    unit = {"id": uid, "kind": kind, "targets": targets, "status": "pending", "attempts": 0, **extra}
    ledger["units"].append(unit)
    return unit


def pack(paths: list[str], pages: dict, max_pages: int = MAX_PAGES) -> list[list[str]]:
    groups, group, size = [], [], 0
    for path in sorted(paths):
        n = int(pages[path].get("bytes", 0))
        if group and (len(group) >= max_pages or size + n > MAX_BYTES):
            groups.append(group)
            group, size = [], 0
        group.append(path)
        size += n
    if group:
        groups.append(group)
    return groups


def reconcile(ledger: dict, pages: dict, duplicates: list[dict], orphans: list[str]) -> None:
    for pair in duplicates:
        add(ledger, "duplicates", pair["pages"])
    for group in pack(orphans, pages):
        add(ledger, "orphans", group)
    assigned = {p for u in ledger["units"] if u["kind"] == "semantic" for p in u["targets"]}
    content = {p for p in pages if PurePosixPath(p).name not in {"index.md", "log.md"}}
    for group in pack(list(content - assigned), pages):
        add(ledger, "semantic", group)
    add(ledger, "catalog", [])
    add(ledger, "introduction", [])


class DependencyReads(set):
    """Exact file reads do not depend on unrelated directory membership."""
    membership_sensitive = False


def dependency_digest(reads, fingerprints: dict) -> str:
    if reads == "all":
        return digest(fingerprints)
    if reads == "content":
        return digest({p: value for p, value in fingerprints.items() if p != ".library-introduction.json"})
    return digest({p: fingerprints.get(p) for p in reads})


def valid(unit: dict, fingerprints: dict, context: str) -> bool:
    # Owner notes are applied actions, not a claim to replay whenever a later
    # quality pass edits a page. Their identity remains in review context.
    if unit["kind"] == "notes":
        return unit["status"] == "done"
    return (unit["status"] == "done" and unit.get("context") == context
            and (unit.get("membership_sensitive", True) is False or unit.get("membership") == digest(sorted(fingerprints)))
            and unit.get("dependency_digest") == dependency_digest(unit.get("reads", []), fingerprints))


def pending(ledger: dict, fingerprints: dict, context: str) -> list[dict]:
    order = {kind: i for i, kind in enumerate(("duplicates", "orphans", "semantic", "catalog", "introduction", "notes"))}
    return sorted((u for u in ledger["units"] if u["status"] != "split" and not valid(u, fingerprints, context)),
                  key=lambda u: (order[u["kind"]], u["id"]))


def complete(unit: dict, fingerprints: dict, context: str, reads: set[str], summary: str) -> None:
    selected = sorted(reads | set(unit["targets"]))
    if unit["kind"] in {"introduction", "notes"} or set(selected) >= set(fingerprints):
        scope = "all"
    elif unit["kind"] == "catalog" or set(selected) >= set(fingerprints) - {".library-introduction.json"}:
        scope = "content"
    else:
        scope = selected
    unit.update(status="done", reads=scope,
                membership_sensitive=(not isinstance(reads, DependencyReads) or reads.membership_sensitive or scope in ("all", "content")),
                dependency_digest=dependency_digest(scope, fingerprints),
                membership=digest(sorted(fingerprints)), context=context,
                completed_at=now(), summary=str(summary)[:1500])
    unit.pop("last_error", None)


def split(ledger: dict, unit: dict) -> list[dict]:
    if unit["kind"] not in {"semantic", "orphans"} or len(unit["targets"]) <= 1:
        return []
    mid = len(unit["targets"]) // 2
    children = [add(ledger, unit["kind"], part, parent=unit["id"])
                for part in (unit["targets"][:mid], unit["targets"][mid:])]
    unit.update(status="split", children=[child["id"] for child in children], last_error="model_call_budget_exceeded")
    ledger["split_count"] = int(ledger.get("split_count", 0)) + 1
    return children


def projection(ledger: dict, fingerprints: dict, context: str) -> dict:
    units = [u for u in ledger["units"] if u["status"] != "split"]
    signature = digest([fingerprints, context])
    done = sum(valid(u, fingerprints, context) for u in units)
    done += int(ledger.get("ledger_signature") == signature) + int(ledger.get("media_signature") == signature)
    return {"version": VERSION, "stage": ledger.get("stage", "review"),
            "total": len(units) + 2, "done": done, "pending": len(units) + 2 - done,
            "current_unit": ledger.get("current_unit", ""),
            "current_kind": ledger.get("current_kind", ""),
            "split_count": ledger.get("split_count", 0), "passes": ledger.get("passes", 0),
            "updated_at": ledger.get("updated_at", ""), "last_completed_at": ledger.get("last_completed_at", "")}


def directive(unit: dict, locale: str | None, completed: list[dict]) -> str:
    targets = "\n".join("- candidate/" + p for p in unit["targets"])
    handoff = "\n".join(f"- {u['kind']} {u['id']}: {u.get('summary', '')[:300]}" for u in completed[-12:])
    en = (locale or "en").lower().startswith("en")
    goals = {
        "duplicates": ("Judge this explicit duplicate pair: merge with combined provenance and corrected links, or explain why both pages must remain.", "判断这对重复页：合并并保留完整来源、修复链接，或说明两页各自保留的理由。"),
        "orphans": ("Make these orphan pages reachable from the index. Preserve valid knowledge; remove a page only after judging it genuinely redundant.", "将这些孤儿页接入目录。保留有效知识；只有确认内容冗余才可删除页面。"),
        "semantic": ("Review the assigned pages for cross-batch contradictions, factual/source support, uncertainty and consistent terminology. Consult other pages and frozen Raw as needed. Apply owner rulings; record unresolved questions in REVIEW_NOTES.json for consolidated investigation. Focus edits on these subjects; do not recompile unrelated pages.", "核对分配页面的跨批矛盾、事实与来源依据、存疑项和术语一致性。按需查阅其他页面与冻结原料，应用负责人裁决，将无法确定的冲突保留为明确问题。围绕分配主题修改，不要重编无关页面。"),
        "catalog": ("Review the complete index and page titles for coherent global routing and cross-batch structure. Use the prior unit receipts and authoring ledgers; repair index grouping/links. Read REVIEW_NOTES.json and resolve deferred investigations using completed batches; escalate only material Q&A issues requiring an owner decision through file_ticket. Do not repeat a full-body review of every already-reviewed page unless a concrete new inconsistency requires it.", "完整核对目录与各页标题的全库导航和跨批结构。利用已完成任务回执及编译账本修正目录分组与链接；仅在发现具体新矛盾时回查已核对页面，不要无目标地重审所有正文。"),
        "introduction": ("Read the finished index and prior review receipts. Call report_domain for the complete library with its accurate domain, overview and reading guide. Do not repeat body editing; report a concrete issue if the final library still has a structural gap.", "阅读最终目录与已完成核对回执，为完整知识库调用 report_domain，给出准确领域、概览和阅读指南。不要重复修改正文；若仍有结构缺口，明确指出具体问题。"),
        "notes": ("Apply these owner notes to the candidate and report exactly what changed: ", "处理以下负责人补充意见，并说明具体修改："),
    }
    lead = f"[Finalization unit {unit['id']} · {unit['kind']}]" if en else f"【终审任务 {unit['id']} · {unit['kind']}】"
    access = ("The full frozen Raw and Candidate remain available through read/search. This is one bounded responsibility, not a read-visibility restriction. The machine owns BATCH_PLAN and COMPILATION_STATE; do not edit them. Finish with a concise judgment and list the touched pages. Report uncertainty honestly; do not fabricate facts or suppress quality findings."
              if en else "仍可通过读取和检索访问完整冻结原料与候选库。此处只划分任务责任，不限制全库可见性。BATCH_PLAN 和 COMPILATION_STATE 由系统维护，请勿修改。结束时简述判断与修改页面；诚实保留不确定性，不编造事实或隐藏质量问题。")
    return "\n\n".join([lead, goals[unit["kind"]][0 if en else 1] + unit.get("notes", ""), targets, access, "Read authoring/REVIEW_NOTES.json if present. Reuse review_id; investigate before escalating to the owner.", handoff])
