import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTAINER_SENSITIVE_PATHS, SENSITIVE_PATH_EXAMPLES } from "./command-sets.js";
import { globReachesSensitivePath } from "./command-validator.js";

/** Shared argument guard for reviewed scripts and dynamic MCP calls. Literal
 * arguments are not permission to read credentials; reuse the shell policy's
 * sensitive paths and glob matcher instead of a second whitelist. */
export function argumentPathSecurityError(values: readonly string[], options: {
  cwd?: string; privateRoots?: readonly string[];
} = {}): string | null {
  const cwd = options.cwd ?? process.cwd();
  const roots = [...(options.privateRoots ?? []), path.resolve(cwd, ".siclaw/config"),
    ...(process.env.SICLAW_CONFIG_DIR ? [path.resolve(process.env.SICLAW_CONFIG_DIR)] : [])].flatMap(root => {
      const absolute = path.resolve(root);
      try { return [absolute, fs.realpathSync(absolute)]; } catch { return [absolute]; }
    });
  for (const raw of values) {
    let value = raw.startsWith("-") && raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : raw;
    if (!value || value.startsWith("-") && !value.includes("/")) continue;
    for (let decode = 0; decode < 3; decode++) {
      if (value.startsWith("file:")) {
        try { value = fileURLToPath(value); } catch { return "Invalid filesystem reference in operation arguments."; }
      }
      const candidates = new Set([value, path.posix.normalize(value), path.posix.normalize("/" + value.replace(/^@/, ""))]);
      const absolute = path.resolve(cwd, value.replace(/^@/, ""));
      candidates.add(absolute);
      try { candidates.add(fs.realpathSync(absolute)); } catch { /* remote or nonexistent operand */ }
      for (const candidate of candidates) {
        if (CONTAINER_SENSITIVE_PATHS.some(pattern => { pattern.lastIndex = 0; return pattern.test(candidate); }) ||
            globReachesSensitivePath(candidate, SENSITIVE_PATH_EXAMPLES) ||
            roots.some(root => candidate === root || candidate.startsWith(path.resolve(root) + path.sep))) {
          return "Arguments reference credential or private agent paths; the operation is not authorized.";
        }
      }
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      } catch { break; }
    }
  }
  return null;
}
