/** Server-verified excerpt of the frozen Raw input; coordinates are not live-document anchors. */
export interface KnowledgeSourceLocation {
  page: string;
  page_sha256: string;
  evidence_id: string;
  raw_sha256: string;
  start_line: number;
  end_line: number;
  section?: string;
  excerpt: string;
}

export function normalizeSourceLocations(value: unknown): KnowledgeSourceLocation[] {
  if (!Array.isArray(value)) return [];
  const result: KnowledgeSourceLocation[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const v = item as KnowledgeSourceLocation;
    if (typeof v.page !== "string" || typeof v.evidence_id !== "string" ||
        !/^[a-f0-9]{64}$/.test(v.page_sha256 ?? "") || !/^[a-f0-9]{64}$/.test(v.raw_sha256 ?? "") ||
        !Number.isSafeInteger(v.start_line) || !Number.isSafeInteger(v.end_line) ||
        v.start_line < 1 || v.end_line < v.start_line || v.end_line - v.start_line >= 20 ||
        typeof v.excerpt !== "string" || !v.excerpt.trim() || Array.from(v.excerpt).length > 1200) continue;
    const key = JSON.stringify([v.page, v.page_sha256, v.evidence_id, v.raw_sha256, v.start_line, v.end_line]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ page: v.page, page_sha256: v.page_sha256, evidence_id: v.evidence_id,
      raw_sha256: v.raw_sha256, start_line: v.start_line, end_line: v.end_line,
      ...(typeof v.section === "string" ? { section: v.section } : {}), excerpt: v.excerpt });
  }
  return result;
}

/** Group document links without discarding different positions in one original. */
export function mergeKnowledgeCitationLocations(values: KnowledgeSourceCitation[]): KnowledgeSourceCitation[] {
  const out = new Map<string, KnowledgeSourceCitation>();
  for (const value of values) {
    const previous = out.get(value.url);
    const locations = normalizeSourceLocations([...(previous?.locations ?? []), ...(value.locations ?? [])]);
    out.set(value.url, { ...(previous ?? value), ...(locations.length ? { locations } : {}) });
  }
  return [...out.values()];
}

export interface KnowledgeSourceCitation {
  locations?: KnowledgeSourceLocation[];
  title: string;
  url: string;
  resource?: string;
  sourceId?: string;
  page?: string;
  evidence?: string;
  /** Knowledge repo UUID the cited page belongs to (attribution, not rendering). */
  repoId?: string;
  /** The answer statement the model bound to this page (pages path only). */
  claim?: string;
}

/**
 * Per-message attribution record persisted in chat-message metadata under
 * `knowledge_citations`. It exists so a reader's feedback on an answer can be
 * traced back to the knowledge repo(s) and pages that answer cited — the
 * runtime's self-report, a prefill a human confirms, never authority.
 */
export interface KnowledgeCitationsMetadata {
  repo_ids: string[];
  pages: Array<{ repo_id?: string; page?: string; url: string; source_id?: string; evidence?: string; claim?: string; locations?: KnowledgeSourceLocation[] }>;
}

export function knowledgeCitationsMetadata(citations: KnowledgeSourceCitation[]): KnowledgeCitationsMetadata {
  const repoIds: string[] = [];
  const pages: KnowledgeCitationsMetadata["pages"] = [];
  for (const c of citations.slice(0, MAX_KNOWLEDGE_CITATIONS)) {
    if (c.repoId && !repoIds.includes(c.repoId)) repoIds.push(c.repoId);
    pages.push({
      ...(c.repoId ? { repo_id: c.repoId } : {}),
      ...(c.page ? { page: c.page } : {}),
      url: c.url,
      ...(c.sourceId ? { source_id: c.sourceId } : {}),
      ...(c.evidence ? { evidence: c.evidence } : {}),
      ...(c.claim ? { claim: c.claim } : {}),
      ...(c.locations?.length ? { locations: c.locations } : {}),
    });
  }
  return { repo_ids: repoIds, pages };
}

// Shared ceiling for one knowledge_cite result, the tool's evidence_refs /
// pages maxItems, and the rendered references list (including Feishu cards).
// The raise from 3 to 8 is intentional for both evidence and legacy paths:
// a multi-source answer must not lose the fourth original after the runtime
// already validated it. This is not the per-marker source cap — that is
// MAX_EVIDENCE_SOURCES_PER_MARKER, mirrored by Python `_MAX_EVIDENCE_SOURCES`.
export const MAX_KNOWLEDGE_CITATIONS = 8;

/** Max `sources` inside one `okf:evidence` marker. Keep equal to selfcheck.py. */
export const MAX_EVIDENCE_SOURCES_PER_MARKER = 8;

// knowledge_cite `pages[].claim` length bounds, in Unicode CODE POINTS. pi does
// not validate the TypeBox schema, so the runtime is the real enforcer
// (`codePointLength`); the schema advertises the same two numbers. One source
// for both so the advertised and enforced limits cannot drift.
export const CLAIM_MIN_LENGTH = 4;
export const CLAIM_MAX_LENGTH = 300;

export function normalizeKnowledgeSourceCitations(value: unknown): KnowledgeSourceCitation[] {
  if (!Array.isArray(value)) return [];
  const out: KnowledgeSourceCitation[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    if (parsed.protocol !== "https:") continue;
    if (!seen.has(parsed.href) && seen.size >= MAX_KNOWLEDGE_CITATIONS) continue;
    const titleRaw = typeof row.title === "string" ? row.title : "";
    const title = titleRaw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "原文";
    seen.add(parsed.href);
    out.push({
      title,
      url: parsed.href,
      ...(Array.isArray(row.locations) ? { locations: normalizeSourceLocations(row.locations) } : {}),
      resource: typeof row.resource === "string" ? row.resource : undefined,
      sourceId: typeof row.sourceId === "string" ? row.sourceId : undefined,
      page: typeof row.page === "string" ? row.page : undefined,
      evidence: typeof row.evidence === "string" ? row.evidence : undefined,
      repoId: typeof row.repoId === "string" && row.repoId.trim() ? row.repoId.trim().slice(0, 64) : undefined,
      claim: typeof row.claim === "string" && row.claim.trim()
        ? Array.from(row.claim.trim()).slice(0, CLAIM_MAX_LENGTH).join("")
        : undefined,
    });
  }
  return mergeKnowledgeCitationLocations(out);
}

export function appendKnowledgeSourceCitations(text: string, value: unknown): string {
  if (!text.trim()) return text;
  const citations = normalizeKnowledgeSourceCitations(value);
  if (citations.length === 0) return text;
  const heading = /[\u3400-\u9fff]/u.test(text) ? "参考原文" : "Original sources";
  // WHATWG URL accepts literal parentheses in an https path. Left raw, `)`
  // closes a Markdown destination early and the remaining path can be parsed as
  // attacker-controlled document text. Percent-encoding preserves the URL while
  // keeping the destination inside the one link we render.
  const chinese = heading === "参考原文";
  let remaining = 8;
  const plain = (value: string) => value.replace(/[\r\n\t]+/g, " ").replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&");
  const lines = citations.map((source) => {
    const destination = source.url.replaceAll("(", "%28").replaceAll(")", "%29");
    let line = `- [${source.title.replace(/[\[\]]/g, "")}](${destination})`;
    const positions = source.locations ?? [];
    const shown = positions.slice(0, remaining);
    remaining -= shown.length;
    for (const location of shown) {
      const quote = Array.from(location.excerpt);
      const preview = quote.slice(0, 400).join("") + (quote.length > 400 ? "…" : "");
      const label = chinese ? "编译时原文快照" : "Compiled source snapshot";
      line += `\n  ${location.section ? `${plain(location.section)} · ` : ""}${label} L${location.start_line}–${location.end_line}\n  > ${plain(preview)}`;
    }
    if (positions.length > shown.length) line += chinese
      ? `\n  另有 ${positions.length - shown.length} 处证据位置未展开。`
      : `\n  ${positions.length - shown.length} additional evidence positions are not expanded.`;
    return line;
  });
  const sourceList = lines.join("\n");
  const trimmedText = text.trimEnd();
  // A relayed or pre-rendered answer can already carry this exact footer.
  // Source titles can change language detection after the first append, so
  // recognize either supported heading while matching the complete source list.
  if (["参考原文", "Original sources"].some((existingHeading) =>
    trimmedText.endsWith(`\n\n### ${existingHeading}\n\n${sourceList}`),
  )) return text;
  return `${trimmedText}\n\n### ${heading}\n\n${sourceList}`;
}
