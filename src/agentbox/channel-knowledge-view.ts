import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ChannelExecutionPolicy } from "../shared/channel-execution-policy.js";

const ownedViews = new Set<string>();
const admittedSidecars = new Set([".okf-routes.json", ".library-introduction.json"]);
interface Repository { id: string; root: string; [key: string]: unknown }

/** Cleanup is limited to a view created by this process, never a caller path. */
export function disposeChannelKnowledgeView(target: string): void {
  if (!ownedViews.delete(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

/** Copy only selected repositories from the authoritative materializer
 * manifest. Preserve per-repo sources and verified citation route sidecars.
 * Missing/unsafe manifests fail closed; there is no whole-mount fallback. */
export function createChannelKnowledgeView(source: string, policy: ChannelExecutionPolicy): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-channel-knowledge-"));
  // Like the authoritative knowledge mount, selected bytes must be readable
  // by the separate sandbox UID. Executor read grants still scope each view.
  fs.chmodSync(target, 0o755);
  ownedViews.add(target);
  try {
    if (!policy.operations.includes("knowledge") || !policy.knowledgeIds.length) return target;
    const manifestPath = path.join(source, ".citation-manifest.json");
    if (!fs.existsSync(manifestPath)) throw new Error("Channel knowledge needs an authoritative repository manifest");
    if (fs.lstatSync(source).isSymbolicLink() || fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error("Unsafe channel knowledge mount");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(manifest.repos)) throw new Error("Invalid knowledge repository manifest");
    const repos = manifest.repos.filter((repo: Repository) => policy.knowledgeIds.includes(repo.id)) as Repository[];
    if (repos.length !== policy.knowledgeIds.length || new Set(repos.map(repo => repo.id)).size !== repos.length)
      throw new Error("Selected channel knowledge is unavailable or ambiguous");
    let bytes = 0, files = 0;
    const copy = (from: string, to: string): void => {
      const stat = fs.lstatSync(from);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error("Unsafe knowledge entry");
      if (stat.isDirectory()) {
        fs.mkdirSync(to, { recursive: true, mode: 0o755 });
        for (const name of fs.readdirSync(from))
          if (!name.startsWith(".") || admittedSidecars.has(name)) copy(path.join(from, name), path.join(to, name));
      } else {
        bytes += stat.size; files++;
        if (bytes > 64 * 1024 * 1024 || files > 10000) throw new Error("Channel knowledge view exceeds its budget");
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
        fs.copyFileSync(from, to); fs.chmodSync(to, 0o444);
      }
    };
    for (const repo of repos) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(repo.id)) throw new Error("Invalid knowledge repository ID");
      if (repo.root === "" && manifest.repos.length !== 1) throw new Error("Ambiguous shared knowledge root cannot be exposed to a channel");
      if (typeof repo.root !== "string" || path.isAbsolute(repo.root) || repo.root.includes("\\") || repo.root.split("/").some(part => part === ".."))
        throw new Error("Invalid knowledge library root");
      let real = path.resolve(source);
      for (const part of repo.root.split("/").filter(Boolean)) {
        real = path.join(real, part);
        if (fs.lstatSync(real).isSymbolicLink()) throw new Error("Unsafe knowledge library path");
      }
      copy(real, path.join(target, "repos", repo.id));
    }
    fs.writeFileSync(path.join(target, ".citation-manifest.json"), JSON.stringify({ version: manifest.version ?? 1,
      repos: repos.map(repo => ({ ...repo, root: `repos/${repo.id}` })) }), { mode: 0o444 });
    fs.writeFileSync(path.join(target, "index.md"), repos.map(repo => `- [[repos/${repo.id}/index]] - ${repo.id}`).join("\n"), { mode: 0o444 });
    return target;
  } catch (error) {
    disposeChannelKnowledgeView(target);
    throw error;
  }
}
