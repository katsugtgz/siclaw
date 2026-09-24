"""Optional independent image review.

A fresh transcriber and text comparer offer hypotheses to the context-aware
compiler. Neither transcript completeness nor factual correctness is certified
by this workflow. The compiler must inspect original evidence before accepting
corrections. Deterministic code owns transport, budgets and durable receipts.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
import time
from pathlib import Path


from redblue import _agent_json  # JSON call + one lenient retry, shared shape
from selfcheck import _is_en, candidate_pages, embedded_image_edges, read_selfcheck
from media_progress import MediaProgress

TRANSCRIPTS_PATH = "authoring/MEDIA_TRANSCRIPTS.json"
TRANSCRIPTS_DIR = "authoring/media-transcripts"
_TRANSCRIPT_CHAR_CAP = 6000  # per image, persisted
_COMPARE_PAGE_CHARS = 24000
_COMPARE_OVERLAP_CHARS = 1000
TRANSCRIPT_CONTRACT_VERSION = 2


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _transcribe_model() -> str:
    return _env("KBC_MV_TRANSCRIBE_MODEL", "claude-sonnet-4-6")


def _compare_model() -> str:
    return _env("KBC_MV_COMPARE_MODEL", "claude-opus-4-6")


TRANSCRIBE_SYSTEM_EN = """You are an image transcriber. You look at this one image only and transcribe the information **visible** in it into structured JSON.
Iron rules: do not write a single word of information the image does not contain (no inference, no filling in, no free association); mark values you cannot read as "unreadable";
every number in a table or monitoring screenshot must sit under its column header; for bar/line charts, write out the legend (color → series) and the axes first,
then transcribe bar by bar / point by point, tagging each value with its series; record N/A or offline rows exactly as shown."""

TRANSCRIBE_SYSTEM_ZH = """你是图像转写员。你只看眼前这一张图,把图里**可见**的信息转写成结构化 JSON。
铁则:图里没有的信息一个字都不要写(不要推断、不要补全、不要联想);读不清的值标 "不可读";
表格/监控截图的每个数值必须挂在它的列名下;柱状图/折线图必须先写出图例(颜色→系列)与坐标轴,
再逐柱/逐点转写,每个值标它属于哪个系列;N/A 或离线的行照原样记录。"""

TRANSCRIBE_USER_EN = """Open this image with Read and transcribe it: {img}

Output valid JSON only (no other text), structured as:
{{"chart_type": "table/bar chart/line chart/UI screenshot/flow diagram/other",
  "title_or_header": "the title or header visible in the image, else null",
  "legend": {{"series name": "color description", ...}} or null,
  "axes": "axis meanings and units, else null",
  "facts": [{{"label": "row/column/series locator", "value": "visible value"}}, ...],
  "illegible": ["parts you cannot read", ...],
  "notes": "other visible points (still only what the image shows)"}}"""

TRANSCRIBE_USER_ZH = """用 Read 打开这张图并转写:{img}

只输出合法 JSON(不要其他文字),结构:
{{"chart_type": "表格/柱状图/折线图/界面截图/流程图/其他",
  "title_or_header": "图内可见的标题或表头,没有则 null",
  "legend": {{"系列名": "颜色描述", ...}} 或 null,
  "axes": "坐标轴含义与单位,没有则 null",
  "facts": [{{"label": "行/列/系列定位", "value": "可见值"}}, ...],
  "illegible": ["读不清的部分", ...],
  "notes": "其他可见要点(仍然只写图里有的)"}}"""

COMPARE_SYSTEM_EN = """You are the comparer for knowledge-base image claims. You cannot see the images themselves — only the
structured transcripts produced by a separate transcriber (each may be incomplete or mistaken)
and the body text of the knowledge page that cites those images.
Your job: check every claim on the page whose source annotation names one of these images, and report exactly two kinds of problems:
- "不一致" (inconsistent): the claim conflicts with the transcript's value or attribution (e.g. a memory-column
  number reported as utilization, or a P0 series written up as P1);
- "超出转写范围" (beyond the transcript): the claim carries this image as its source tag, but nothing in the
  transcript can support it (typical: the image shows no model name, yet the page says "the model is X" and cites
  this image — an inference dressed up as a sourced fact).
Do not report claims that agree with the transcript; content citing other, non-image sources is not yours to check;
when unsure whether something qualifies, lean toward reporting it and let a human decide."""

COMPARE_SYSTEM_ZH = """你是知识库图像断言的【比对员】。你看不到图片本身——只有另一位转写员产出的
结构化转写(它可能遗漏信息或读错)和引用了该图的知识页正文。
你的任务:逐条核对页面里标注来源为这些图片的断言,只报两类问题:
- 不一致:断言与转写的值/归属冲突(如把显存列的数值写成利用率、把 P0 系列写成 P1);
- 超出转写范围:断言挂着该图的来源标注,但转写里根本没有能支撑它的信息
  (典型:图里没有型号名,页面却说"型号是 X"并引用该图——这是把推断伪装成带源事实)。
与转写一致的断言不要报;页面引用其他非图片来源的内容不归你管;拿不准算不算的,倾向于报出来让人裁。"""

COMPARE_USER_EN = """Knowledge page: {page}
Full page text:
--------
{page_text}
--------

Transcripts of the images this page cites (produced by a transcriber who saw only the image — an independent, potentially incomplete reading):
{transcripts_json}

Output valid JSON only (no other text):
{{"findings": [{{"image": "image path relative to raw", "claim": "the page's original claim (quoted)",
   "kind": set kind to exactly "不一致" (inconsistent) or "超出转写范围" (beyond the transcript),
   "expected": "the matching fact from the transcript; for beyond-the-transcript findings write \\"not in the transcript\\"",
   "fix": "one-line fix (change to the transcribed value / downgrade to ⚠️ uncertain + file a ticket / re-attribute to the correct source)"}}]}}
If there are no problems, output {{"findings": []}}."""

COMPARE_USER_ZH = """知识页:{page}
页面全文:
--------
{page_text}
--------

该页引用的图片转写(转写员只看图产出,可能遗漏或误读图中信息):
{transcripts_json}

只输出合法 JSON(不要其他文字):
{{"findings": [{{"image": "图片相对路径", "claim": "页面里的原断言(摘录)",
   "kind": "不一致" 或 "超出转写范围",
   "expected": "转写里的对应事实;超出范围时写「转写中无此信息」",
   "fix": "一句话修法(改成什么值 / 降级⚠️存疑+落工单 / 改挂正确来源)"}}]}}
没有问题就输出 {{"findings": []}}。"""


def _transcribe_prompts(locale: str | None) -> tuple[str, str]:
    if _is_en(locale):
        return TRANSCRIBE_SYSTEM_EN, TRANSCRIBE_USER_EN
    return TRANSCRIBE_SYSTEM_ZH, TRANSCRIBE_USER_ZH


def _compare_prompts(locale: str | None) -> tuple[str, str]:
    if _is_en(locale):
        return COMPARE_SYSTEM_EN, COMPARE_USER_EN
    return COMPARE_SYSTEM_ZH, COMPARE_USER_ZH


def _sha8(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()[:8]


def load_transcripts(workdir: str) -> dict:
    p = Path(workdir) / TRANSCRIPTS_PATH
    cache = {}
    if p.is_file():
        v = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(v, dict):
            raise ValueError("invalid legacy media transcript cache")
        cache.update(v)
    for shard in sorted((Path(workdir) / TRANSCRIPTS_DIR).glob("*.json")):
        item = json.loads(shard.read_text("utf-8"))
        if not isinstance(item, dict) or not isinstance(item.get("image"), str) or not isinstance(item.get("transcript"), dict):
            raise ValueError("invalid media transcript cache shard")
        cache[item["image"]] = {k: item[k] for k in ("sha8", "sha256", "contract", "transcript") if k in item}
    return cache


def save_transcript(workdir: str, image: str, value: dict) -> None:
    # Stable per-image files avoid the workspace per-file sync limit and keep
    # completed work durable while sibling transcriptions are still running.
    key = hashlib.sha256(image.encode("utf-8")).hexdigest()
    p = Path(workdir) / TRANSCRIPTS_DIR / (key + ".json")
    p.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps({"image": image, **value}, ensure_ascii=False) + "\n"
    if p.is_file() and p.read_text("utf-8") == content:
        return
    temporary = p.with_suffix(".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(p)


def save_transcripts(workdir: str, cache: dict) -> None:
    for image, value in cache.items():
        save_transcript(workdir, image, value)


async def transcribe_image(engine, workdir: str, img_rel: str, cache: dict,
                           locale: str | None = None) -> dict | None:
    """One blind transcription, cached by image content hash (incremental
    recompiles re-verify for free). None on failure (caller records the error)."""
    img_path = Path(workdir) / "raw" / img_rel
    if not img_path.is_file():
        return None
    sha = hashlib.sha256(img_path.read_bytes()).hexdigest()
    system, user = _transcribe_prompts(locale)
    contract = hashlib.sha256(json.dumps(
        [TRANSCRIPT_CONTRACT_VERSION, _transcribe_model(), system, user],
        ensure_ascii=False).encode("utf-8")).hexdigest()
    hit = cache.get(img_rel)
    if (isinstance(hit, dict) and hit.get("sha256") == sha
            and hit.get("contract") == contract and isinstance(hit.get("transcript"), dict)):
        return hit["transcript"]
    raw_dir = str(Path(workdir) / "raw")
    data = await _agent_json(
        engine, stage="transcribe", system=system,
        user=user.format(img=str(img_path.resolve())),
        model=_transcribe_model(), role="transcribe", cwd=raw_dir, roots=[raw_dir],
        timeout=float(_env("KBC_MV_TRANSCRIBE_TIMEOUT", "240")))
    if not isinstance(data, dict) or not isinstance(data.get("facts"), list):
        raise ValueError("Image transcription did not return a facts list")
    if len(json.dumps(data, ensure_ascii=False)) > _TRANSCRIPT_CHAR_CAP:
        raise ValueError("Image transcript exceeds the bounded evidence budget; incomplete transcripts cannot verify a page")
    cache[img_rel] = {"sha8": sha[:8], "sha256": sha, "contract": contract, "transcript": data}
    save_transcript(workdir, img_rel, cache[img_rel])
    return data


def comparison_segments(text: str):
    """Cover every character, retaining overlap for claims at segment edges."""
    start = 0
    while start < len(text):
        end = min(len(text), start + _COMPARE_PAGE_CHARS)
        if end < len(text):
            # Prefer a paragraph/line boundary without creating tiny chunks.
            boundary = text.rfind("\n", start + _COMPARE_PAGE_CHARS // 2, end)
            if boundary >= 0:
                end = boundary + 1
        yield start, end, text[start:end]
        if end == len(text):
            break
        start = max(start + 1, end - _COMPARE_OVERLAP_CHARS)


def _embedding_note(embedded_by: dict[str, list[str]] | None, locale: str | None) -> str:
    """Tell the comparer which cited documents carry each image.

    A page that learned from a document tags the DOCUMENT, not the screenshot
    inside it, so an image-tag-only comparison checks nothing on such a page.
    Document-tagged claims may only be reported as visible contradictions: the
    document text legitimately says more than any one screenshot shows."""
    if not embedded_by:
        return ""
    mapping = json.dumps(embedded_by, ensure_ascii=False, sort_keys=True)
    if _is_en(locale):
        return ("\nSome transcribed images reach this page through a document it cites, which embeds them "
                f"(image → embedding documents): {mapping}\n"
                "A claim tagged with such a document may describe that document's screenshot. For those claims "
                "report only \"不一致\" (inconsistent) — the transcript visibly contradicts the claim, e.g. the text "
                "describes fields, options or steps the screenshot of the same dialog does not show. Never report "
                "\"超出转写范围\" for a document-tagged claim: the document text may support what the image does not show.")
    return ("\n部分已转写图片是经本页引用的文档嵌入而来(图片 → 嵌入它的文档):" + mapping + "\n"
            "挂这些文档来源的断言可能在描述文档里的截图。对这类断言只报「不一致」——转写明显与断言冲突,"
            "例如正文写的字段、选项或步骤在同一弹窗截图里并不存在;不要对挂文档来源的断言报「超出转写范围」,"
            "文档正文本来就可以支持图片里没有的信息。")


async def compare_page(engine, tmp_dir: str, page_rel: str, page_text: str,
                       transcripts: dict[str, dict], locale: str | None = None,
                       embedded_by: dict[str, list[str]] | None = None) -> list[dict]:
    """Compare the entire page in bounded, overlapping text-only sessions.

    A single deadline covers the whole page. A failed/malformed segment raises:
    the caller may retry or record exhaustion, but cannot mark the page passed.
    `embedded_by` (image → cited documents embedding it) lets the comparer
    check document-tagged claims against those documents' screenshots.
    """
    if not page_text.strip():
        raise ValueError("Cannot verify an empty page")
    system, user = _compare_prompts(locale)
    embedding = _embedding_note(embedded_by, locale)
    out, seen = [], set()
    budget = float(_env("KBC_MV_COMPARE_TIMEOUT", "300"))
    deadline = time.monotonic() + budget
    async with asyncio.timeout(budget):
        for start, end, segment in comparison_segments(page_text):
            scope = (f"\nThis is character range [{start},{end}) of a {len(page_text)}-character page. "
                     "Ranges overlap. Judge claims visible in this excerpt; do not assume omitted surrounding text is absent from the page."
                     if _is_en(locale) else
                     f"\n本段覆盖全页 {len(page_text)} 字符中的 [{start},{end})，分段间有重叠。"
                     "只判断本段可见断言，不要把本段未展示的上下文当成整页缺失。")
            data = await _agent_json(
                engine, stage="compare", system=system,
                user=user.format(page=page_rel, page_text=segment,
                                 transcripts_json=json.dumps(transcripts, ensure_ascii=False)) + embedding + scope,
                model=_compare_model(), role="compare", cwd=tmp_dir, roots=[tmp_dir],
                timeout=max(0.001, deadline - time.monotonic()))
            if not isinstance(data, dict) or not isinstance(data.get("findings"), list):
                raise ValueError("Image comparison did not return a findings list")
            for finding in data["findings"]:
                if not isinstance(finding, dict) or not isinstance(finding.get("claim"), str) or not finding["claim"].strip():
                    raise ValueError("Image comparison returned a malformed finding")
                if finding.get("image") not in transcripts or finding.get("kind") not in {"不一致", "超出转写范围"}:
                    raise ValueError("Image comparison referenced unknown evidence or finding kind")
                value = {"page": page_rel, "image": str(finding.get("image", "")),
                         "kind": str(finding.get("kind", "不一致")),
                         "claim": finding["claim"][:200],
                         "expected": str(finding.get("expected", ""))[:200],
                         "fix": str(finding.get("fix", ""))[:200]}
                identity = (value["image"], finding["claim"].strip(), value["kind"])
                if identity not in seen:
                    seen.add(identity)
                    out.append(value)
    return out


async def run_blind_verify(engine, workdir: str, pending: dict[str, list[str]],
                           progress=None, locale: str | None = None,
                           run_id: str = "", on_progress=None) -> dict:
    """Transcribe every image in `pending` (cache-aware, concurrent), then
    compare each page against its transcripts. Fail-open per item: a failed
    transcript/compare is recorded in errors, never raises."""
    say = progress or (lambda s: None)
    en = _is_en(locale)
    sem = asyncio.Semaphore(int(_env("KBC_MV_CONCURRENCY", "3")))
    cache = load_transcripts(workdir)
    images = sorted({img for imgs in pending.values() for img in imgs})
    receipts = ((read_selfcheck(workdir) or {}).get("media_verify") or {}).get("verified_fingerprints") or {}
    missing = sum(page not in receipts for page in pending)
    status = MediaProgress(workdir, run_id, len(images), len(pending), missing, on_progress)
    save_transcripts(workdir, cache)  # migrate inherited aggregate entries
    await status.update("transcribing", cache_entries=len(cache))
    errors: list[str] = []
    transcripts: dict[str, dict] = {}
    hits = 0
    try:
        # Which cited documents carry each pending image. Advisory context for
        # the comparer only; a failure falls back to image-tag comparison.
        embed_edges = embedded_image_edges(workdir)
        page_sources = {rel: list(page.get("sources") or [])
                        for rel, page in candidate_pages(workdir).items()
                        if rel in pending and "error" not in page}
    except Exception:
        embed_edges, page_sources = {}, {}

    def _embedded_by(page: str, imgs: list[str]) -> dict[str, list[str]]:
        out = {}
        for img in imgs:
            docs = sorted(d for d in page_sources.get(page, []) if img in embed_edges.get(d, ()))
            if docs:
                out[img] = docs
        return out

    async def _one(img: str):
        nonlocal hits
        pre = img in cache and cache[img].get("transcript")
        async with sem:
            try:
                t = await transcribe_image(engine, workdir, img, cache, locale=locale)
            except Exception as e:
                errors.append(f"transcription failed {img}: {e!r}" if en
                              else f"转写失败 {img}: {e!r}")
                await status.advance("transcription_failed")
                return
        if t is not None:
            transcripts[img] = t
            if pre is t:
                hits += 1
                await status.advance("cache_hits", effective=True, cache_entries=len(cache))
            else:
                await status.advance("transcribed", effective=True, cache_entries=len(cache))
        else:
            errors.append(f"transcription failed {img}: unparsable output / file missing" if en
                          else f"转写失败 {img}: 无法解析/文件缺失")
            await status.advance("transcription_failed")

    say(f"Self-check (image · blind transcription): transcribing {len(images)} image(s)…" if en
        else f"自检(图像·盲转写):{len(images)} 张图转写中…")
    await status.gather(*(_one(i) for i in images))
    await status.update("comparing", cache_entries=len(cache))

    findings: list[dict] = []
    suppressed_all: list[dict] = []
    completed: list[str] = []
    failed: list[str] = []
    cand = Path(workdir) / "candidate"
    empty = tempfile.mkdtemp(prefix="kbc-mv-")

    async def _page(page: str, imgs: list[str]):
        ts = {i: transcripts[i] for i in imgs if i in transcripts}
        if len(ts) < len(imgs):
            # Partial (or zero) transcripts: comparing against an incomplete
            # inventory would mis-grade BOTH ways — a wrong claim about the
            # missing image has nothing to contradict it (false pass), and a
            # correct claim about it gets flagged beyond-transcript (false
            # fail). Skip the page whole; the caller retries it later.
            missing = len(imgs) - len(ts)
            errors.append(f"page {page}: {missing} image(s) not transcribed — comparison skipped" if en
                          else f"页 {page}: {missing} 张图未转写——本轮不比对")
            failed.append(page)
            await status.advance("comparison_failed")
            return
        try:
            text = (cand / page).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            errors.append(f"failed to read page {page}: {e!r}" if en
                          else f"读页失败 {page}: {e!r}")
            failed.append(page)
            await status.advance("comparison_failed")
            return
        async with sem:
            try:
                raw_findings = await compare_page(engine, empty, page, text, ts, locale=locale,
                                                  embedded_by=_embedded_by(page, imgs))
                kept, suppressed = raw_findings, []  # Numeric overlap is not proof of semantic support.
                findings.extend(kept)
                suppressed_all.extend(suppressed)
            except Exception as e:
                errors.append(f"comparison failed {page}: {e!r}" if en
                              else f"比对失败 {page}: {e!r}")
                failed.append(page)
                await status.advance("comparison_failed")
                return
        completed.append(page)
        await status.advance("pages_compared", effective=True, findings=len(findings))

    say(f"Self-check (image · comparison): comparing {len(pending)} page(s)…" if en
        else f"自检(图像·比对):{len(pending)} 页比对中…")
    await status.gather(*(_page(p, imgs) for p, imgs in pending.items()))
    shutil.rmtree(empty, ignore_errors=True)
    await status.update("complete", findings=len(findings))
    if suppressed_all:
        say(f"Self-check (image · comparison): {len(suppressed_all)} beyond-transcript doubt(s) "
            "auto-resolved — claim verbatim-backed by a co-cited text source (image kept as corroboration)" if en
            else f"自检(图像·比对):{len(suppressed_all)} 条\u201c超出转写范围\u201d疑点因同页文本源逐字背书自动归为佐证,不出卡")
    return {"findings": findings, "errors": errors,
            "images": len(images), "cache_hits": hits,
            "suppressed_text_backed": suppressed_all,
            "completed_pages": sorted(completed), "failed_pages": sorted(failed)}


# Stored finding kinds → English display labels (render-time only; the stored
# values themselves are never translated).
_KIND_LABELS_EN = {"不一致": "inconsistent with the image",
                   "超出转写范围": "beyond what the transcript supports"}


def build_repair_prompt(findings: list[dict], locale: str | None = None) -> str:
    """The bounded repair turn for blind-verify findings — concrete claims,
    concrete expected values, BOX_ROLE contract language. Rendered in the run's
    locale (see _is_en); stored kind tokens are mapped to display labels for en."""
    if _is_en(locale):
        lines = ["[Optional image review] These are model hypotheses, not confirmed errors. Read the original image "
                 "and surrounding source text before deciding. Transcripts may be wrong or incomplete. Accept or reject "
                 "suggestions with evidence; never replace a correct value merely to agree with the transcript. "
                 "Use file_ticket(review_action=investigate) for unresolved material questions, not owner escalation "
                 "for reviewer disagreement. Preserve uncertainty; only edit evidence-supported corrections:"]
        for f in findings[:40]:
            kind = _KIND_LABELS_EN.get(f["kind"], f["kind"])
            lines.append(f"- [{kind}] {f['page']} ← raw/{f['image']}\n"
                         f"  Claim: {f['claim']}\n  Transcript: {f['expected']}\n  Suggestion: {f['fix']}")
        if len(findings) > 40:
            lines.append(f"- …{len(findings)} total (see authoring/SELFCHECK.json for the rest)")
        return "\n".join(lines)
    lines = ["【可选图像复核】以下是模型疑点，不是已确认错误。请先阅读原图及附近原文，结合业务上下文和其他来源判断。"
             "转写可能错误或不完整；可按证据接受或驳回建议，不得为迎合转写修改正确值。重要未解问题用 file_ticket 的 investigate "
             "记录查证，不因审核模型分歧自动提单。保留不确定性，只修正有证据支持的断言："]
    for f in findings[:40]:
        lines.append(f"- [{f['kind']}] {f['page']} ← raw/{f['image']}\n"
                     f"  断言: {f['claim']}\n  转写: {f['expected']}\n  建议: {f['fix']}")
    if len(findings) > 40:
        lines.append(f"- …等共 {len(findings)} 条(其余见 authoring/SELFCHECK.json)")
    return "\n".join(lines)
