import fs from "node:fs";
import path from "node:path";
import { resolveUnderDir } from "../shared/path-utils.js";
import { collectSkillDirectoryFiles, parseSingleSkillPackage } from "../shared/skill-package.js";
import { boundSkillPreviewMetadata } from "../shared/skill-preview-storage.js";
import type { ProductServiceResult } from "./resource-list-service.js";

/** Preview only: never publishes, loads, or executes proposed Skill bytes. */
export function previewSkillDraft(dir: string, options: { draftsRoot?: string; cwd?: string; signal?: AbortSignal } = {}): ProductServiceResult {
  options.signal?.throwIfAborted();
  const root = path.resolve(options.draftsRoot ?? ".siclaw/user-data/skill-drafts");
  if (!dir?.trim()) return failed("dir is required");
  let safeDir: string;
  try { safeDir = resolveUnderDir(root, path.resolve(options.cwd ?? process.cwd(), dir.trim())); }
  catch { return failed("dir must be under the authorized skill-drafts/<name>/ directory"); }
  if (safeDir === root) return failed("dir must be a subdirectory, not the drafts root");
  if (!fs.existsSync(safeDir)) return failed(`Directory not found: ${safeDir}`);
  // The root may live on an owner-mounted volume. Untrusted descendants must
  // not redirect collection or cleanup through a filesystem link.
  const canonicalRoot = fs.realpathSync(root);
  if (fs.lstatSync(root).isSymbolicLink()) return failed("Skill drafts root must not be a link");
  if (options.cwd) {
    const declaredOwner = path.resolve(options.cwd), canonicalOwner = fs.realpathSync(declaredOwner);
    if (!root.startsWith(declaredOwner + path.sep) || canonicalRoot !== path.resolve(canonicalOwner, path.relative(declaredOwner, root)))
      return failed("Skill drafts root is outside the session workspace");
  }
  let cursor = root;
  for (const part of path.relative(root, safeDir).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) return failed("Skill draft directories must not contain links");
  }
  if (!fs.statSync(safeDir).isDirectory() || !fs.realpathSync(safeDir).startsWith(canonicalRoot + path.sep)) return failed("Skill draft is outside the authorized directory");
  try {
    if (!fs.existsSync(path.join(safeDir, "SKILL.md"))) return failed(`SKILL.md not found in ${safeDir}`);
    let parsed;
    try { parsed = parseSingleSkillPackage(collectSkillDirectoryFiles(safeDir)); }
    catch (error) { return failed(error instanceof Error ? error.message : String(error)); }
    options.signal?.throwIfAborted();
    const frontmatter = parsed.specs.match(/^---\n([\s\S]*?)\n---/);
    const type = frontmatter?.[1].match(/^type:\s*(.+)$/m)?.[1].trim() ?? "Custom";
    const result = { skill: { ...parsed, type }, summary: `Skill preview for '${parsed.name}'. Click View to inspect and copy.` };
    const details = boundSkillPreviewMetadata({ skillPreview: result });
    if ("status" in details.skillPreview && details.skillPreview.status === "omitted") {
      return { content: [{ type: "text", text: JSON.stringify({ ...details.skillPreview, error: true,
        summary: "Skill preview could not be saved because the package exceeds the preview storage limit. Generate a smaller preview; these files are not available to view or copy in the chat panel." }) }],
        details: { ...details, error: true } };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }], details };
  } finally {
    try { fs.rmSync(safeDir, { recursive: true, force: true }); } catch { /* NFS may delay */ }
  }
}

function failed(error: string): ProductServiceResult {
  return { content: [{ type: "text", text: JSON.stringify({ error }) }], details: { error: true } };
}
