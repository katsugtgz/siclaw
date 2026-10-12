import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** Codex reads/searches files through its native shell tool. Parse a small
 * read-only argv grammar, authorize paths, then quote EVERY argument ourselves.
 * The submitted shell text is never executed for these commands. */
export function authorizeCodexFileCommand(
  command: string, cwd: string,
  authorize: (uri: string, directory: boolean) => string,
): string | undefined {
  const binary = command.trim().match(/^(\S+)/)?.[1];
  if (!binary || !["cat", "head", "tail", "wc", "ls", "rg", "grep"].includes(binary)) return;
  const args = parseLiteralArgs(command);
  if (args[0] !== binary) throw new Error("Invalid native file command");
  const result = [binary];
  const paths: string[] = [];
  let pattern = binary === "rg" || binary === "grep";
  let flags = true;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (flags && arg === "--") { result.push(arg); flags = false; continue; }
    if (flags && arg.startsWith("-")) {
      const simple = binary === "rg" ? /^(?:-[nHiliscwFx]+|--files|--hidden|--no-heading|--line-number|--fixed-strings)$/
        : binary === "grep" ? /^-[nHiliscwFx]+$/
        : binary === "ls" ? /^-[laAdh1F]+$/
        : binary === "wc" ? /^-[lwc]+$/
        : binary === "cat" ? /^-[nbsETv]+$/ : /^-(?:n|c)$/;
      const valueFlag = (binary === "rg" && ["-g", "--glob", "-e", "--regexp", "-m", "--max-count"].includes(arg))
        || (binary === "grep" && ["-e", "-m"].includes(arg))
        || (["head", "tail"].includes(binary) && ["-n", "-c"].includes(arg));
      if (valueFlag) {
        const value = args[++i];
        if (value === undefined || ((["-n", "-c", "-m", "--max-count"].includes(arg)) && !/^\d{1,7}$/.test(value))) {
          throw new Error("Invalid native file command flag value");
        }
        if (["-e", "--regexp"].includes(arg)) pattern = false;
        result.push(arg, value);
      } else if (simple.test(arg)) {
        if (arg === "--files") pattern = false;
        result.push(arg);
      } else throw new Error(`Native file command flag is not authorized: ${arg}`);
      continue;
    }
    if (pattern) { result.push(arg); pattern = false; continue; }
    const resolved = path.resolve(cwd, arg);
    const directory = binary === "rg" || binary === "ls";
    const allowed = fileURLToPath(authorize(pathToFileURL(resolved).href, directory));
    paths.push(allowed);
    result.push(allowed);
  }
  if (pattern) throw new Error("Native search requires a pattern");
  if (!paths.length) {
    if (!["rg", "ls"].includes(binary)) throw new Error("Native file command requires a path");
    result.push(fileURLToPath(authorize(pathToFileURL(cwd).href, true)));
  }
  return result.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
}

function parseLiteralArgs(text: string): string[] {
  const args: string[] = [];
  let current = "", quote = "", started = false;
  for (const char of text) {
    if (char === "\n" || char === "\r" || char === "\0" || char === "\\") throw new Error("Invalid native file command syntax");
    if (quote) {
      if (char === quote) quote = ""; else current += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) { args.push(current); current = ""; started = false; }
    } else {
      if (/[|;&<>`$(){}*?\[\]]/.test(char)) throw new Error("Native file commands require literal arguments");
      current += char; started = true;
    }
  }
  if (quote) throw new Error("Unclosed native file command quote");
  if (started) args.push(current);
  if (args.length > 100) throw new Error("Too many native file command arguments");
  return args;
}
