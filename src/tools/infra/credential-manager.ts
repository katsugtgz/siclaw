/**
 * Credential writers for headless Portal snapshot materialization.
 *
 * Writes the same manifest.json + credential files format used by Gateway's
 * buildCredentialPayload(), so diagnostic tools share one credential format.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { resolveUnderDir } from "../../shared/path-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CredentialManifestEntry {
  name: string;
  type: string;
  description?: string | null;
  files: string[];
  metadata?: Record<string, unknown>;
}

export interface RegisterKubeconfigOpts {
  name: string;
  /** Absolute path to the source kubeconfig file (provide this OR content) */
  sourcePath?: string;
  /** Raw kubeconfig YAML/JSON content (provide this OR sourcePath) */
  content?: string;
  description?: string;
}

export interface RegisterSshPasswordOpts {
  name: string;
  host: string;
  port?: number;
  username: string;
  password: string;
  description?: string;
}

/**
 * Project-agent delivery credential — the `sfm_` bearer token siforgectl presents to aslan.
 *
 * Nothing here is a permission. The token resolves, server-side, to one project and one real user id,
 * and the delivery platform decides everything from there; see
 * scitix-devops/docs/design/project-agent-cli.md — "Project confinement". `project` and `endpoint` are
 * carried so the client does not have to be told them out of band, not so it can choose them.
 */
export interface RegisterDevopsCredentialOpts {
  name: string;
  /** Base URL of the delivery control plane the token authenticates against. */
  endpoint: string;
  /** The project the token resolves to server-side. Recorded for operator diagnosis. */
  project: string;
  /** Opaque bearer token. Never logged, never echoed, never put in manifest metadata. */
  token: string;
  description?: string;
}

export interface RegisterSshKeyOpts {
  name: string;
  host: string;
  port?: number;
  username: string;
  /** Absolute path to the private key file */
  keyPath: string;
  passphrase?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned) throw new Error("Credential name must contain at least one alphanumeric character");
  return cleaned;
}

/** Reject values that could inject SSH config directives (newlines, leading whitespace). */
function sanitizeSshField(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${fieldName} must not be empty`);
  if (/[\r\n]/.test(trimmed)) throw new Error(`${fieldName} must not contain newlines`);
  return trimmed;
}

/** The credential type directory a setgid `siforgectl` can enter — see Dockerfile.agentbox. */
export const DEVOPS_CREDENTIAL_SUBDIR = "devops";

/**
 * Group-readable, because the reader reaches the file through a setgid group and not as its owner.
 * Every other credential type here is written 0600 and read by the node process itself.
 */
export const DEVOPS_CREDENTIAL_MODE = 0o640;

/** Reject empty values and anything carrying a newline into a single-line record. */
function requireSingleLine(value: string, fieldName: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new Error(`${fieldName} must not be empty`);
  if (/[\r\n]/.test(trimmed)) throw new Error(`${fieldName} must not contain newlines`);
  return trimmed;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function readManifest(credentialsDir: string): CredentialManifestEntry[] {
  const manifestPath = path.join(credentialsDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeManifest(credentialsDir: string, manifest: CredentialManifestEntry[]): void {
  ensureDir(credentialsDir);
  fs.writeFileSync(
    path.join(credentialsDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600 },
  );
}

function writeCredentialFile(credentialsDir: string, filename: string, content: string, mode: number = 0o600): void {
  const filePath = resolveUnderDir(credentialsDir, filename);
  fs.writeFileSync(filePath, content, { mode });
}

// ---------------------------------------------------------------------------
// Registration — type-specific handlers
// ---------------------------------------------------------------------------

type RegisterResult =
  | { entry: CredentialManifestEntry; error?: undefined }
  | { entry?: undefined; error: string };

export function registerKubeconfig(
  credentialsDir: string,
  opts: RegisterKubeconfigOpts,
): RegisterResult {
  let content: string;

  if (opts.content) {
    content = opts.content;
  } else if (opts.sourcePath) {
    const resolvedPath = path.resolve(opts.sourcePath);
    if (!fs.existsSync(resolvedPath)) {
      return { error: `File not found: ${resolvedPath}` };
    }
    content = fs.readFileSync(resolvedPath, "utf-8");
  } else {
    return { error: "Either sourcePath or content is required" };
  }

  // Validate YAML
  let metadata: Record<string, unknown> | undefined;
  try {
    const kc = yaml.load(content) as Record<string, unknown>;
    if (!kc || typeof kc !== "object") {
      return { error: "Invalid kubeconfig: not a YAML object" };
    }
    const clusters = (kc?.clusters as Array<{ name: string; cluster?: { server?: string } }>) ?? [];
    const contexts = (kc?.contexts as Array<{ name: string; context?: { cluster?: string; namespace?: string } }>) ?? [];
    metadata = {
      clusters: clusters.map((c) => ({ name: c.name, server: c.cluster?.server })),
      contexts: contexts.map((c) => ({
        name: c.name,
        cluster: c.context?.cluster,
        namespace: c.context?.namespace,
      })),
      currentContext: kc?.["current-context"] as string | undefined,
    };
  } catch (err) {
    return { error: `Invalid kubeconfig YAML: ${err instanceof Error ? err.message : String(err)}` };
  }

  const safe = safeName(opts.name);
  const filename = `${safe}.kubeconfig`;

  ensureDir(credentialsDir);
  writeCredentialFile(credentialsDir, filename, content);

  const entry: CredentialManifestEntry = {
    name: opts.name,
    type: "kubeconfig",
    description: opts.description ?? null,
    files: [filename],
    ...(metadata ? { metadata } : {}),
  };

  // Update manifest
  const manifest = readManifest(credentialsDir).filter((e) => e.name !== opts.name);
  manifest.push(entry);
  writeManifest(credentialsDir, manifest);

  return { entry };
}

export function registerSshPassword(
  credentialsDir: string,
  opts: RegisterSshPasswordOpts,
): { entry: CredentialManifestEntry } {
  const safe = safeName(opts.name);
  const fileNames: string[] = [];

  ensureDir(credentialsDir);

  // Sanitize SSH fields against config injection
  const host = sanitizeSshField(opts.host, "host");
  const username = sanitizeSshField(opts.username, "username");

  // SSH config
  const sshConfigLines = [`Host ${safe}`];
  sshConfigLines.push(`  HostName ${host}`);
  if (opts.port) sshConfigLines.push(`  Port ${opts.port}`);
  sshConfigLines.push(`  User ${username}`);
  sshConfigLines.push("  StrictHostKeyChecking accept-new");
  const sshConfigFile = `${safe}.ssh_config`;
  writeCredentialFile(credentialsDir, sshConfigFile, sshConfigLines.join("\n") + "\n");
  fileNames.push(sshConfigFile);

  // Password file
  const pwFile = `${safe}.password`;
  writeCredentialFile(credentialsDir, pwFile, opts.password, 0o600);
  fileNames.push(pwFile);

  const entry: CredentialManifestEntry = {
    name: opts.name,
    type: "ssh_password",
    description: opts.description ?? null,
    files: fileNames,
    metadata: {
      host: opts.host,
      ...(opts.port ? { port: opts.port } : {}),
      username: opts.username,
    },
  };

  const manifest = readManifest(credentialsDir).filter((e) => e.name !== opts.name);
  manifest.push(entry);
  writeManifest(credentialsDir, manifest);

  return { entry };
}

export function registerSshKey(
  credentialsDir: string,
  opts: RegisterSshKeyOpts,
): RegisterResult {
  const resolvedKeyPath = path.resolve(opts.keyPath);
  if (!fs.existsSync(resolvedKeyPath)) {
    return { error: `Key file not found: ${resolvedKeyPath}` };
  }

  const safe = safeName(opts.name);
  const fileNames: string[] = [];

  ensureDir(credentialsDir);

  // Copy private key
  const keyContent = fs.readFileSync(resolvedKeyPath, "utf-8");
  const keyFile = `${safe}.key`;
  writeCredentialFile(credentialsDir, keyFile, keyContent, 0o600);
  fileNames.push(keyFile);

  // Sanitize SSH fields against config injection
  const host = sanitizeSshField(opts.host, "host");
  const username = sanitizeSshField(opts.username, "username");

  // SSH config
  const sshConfigLines = [`Host ${safe}`];
  sshConfigLines.push(`  HostName ${host}`);
  if (opts.port) sshConfigLines.push(`  Port ${opts.port}`);
  sshConfigLines.push(`  User ${username}`);
  sshConfigLines.push(`  IdentityFile ${path.join(credentialsDir, keyFile)}`);
  sshConfigLines.push("  StrictHostKeyChecking accept-new");
  const sshConfigFile = `${safe}.ssh_config`;
  writeCredentialFile(credentialsDir, sshConfigFile, sshConfigLines.join("\n") + "\n");
  fileNames.push(sshConfigFile);

  const entry: CredentialManifestEntry = {
    name: opts.name,
    type: "ssh_key",
    description: opts.description ?? null,
    files: fileNames,
    metadata: {
      host: opts.host,
      ...(opts.port ? { port: opts.port } : {}),
      username: opts.username,
    },
  };

  const manifest = readManifest(credentialsDir).filter((e) => e.name !== opts.name);
  manifest.push(entry);
  writeManifest(credentialsDir, manifest);

  return { entry };
}

/**
 * Land a project-agent delivery credential in the AgentBox credential tree.
 *
 * Written through the same manifest the other credential types use, on purpose. A side channel that
 * skipped it would be invisible to every consistency check built on that file — the entry is how an
 * operator can see a credential exists without being able to read it, and how eviction knows what to
 * unlink.
 *
 * Two differences from the kubeconfig/SSH writers, both forced by the reader:
 *
 *   - mode 0640, not 0600. `siforgectl` runs as `sandbox`, which owns nothing here; it reaches this
 *     file through its setgid `devopscred` bit, which is a GROUP permission. 0600 would make the
 *     setgid bit decorative in the other direction — nothing could read the file at all.
 *   - the file lands in the `devops/` type directory rather than the credential root. That directory
 *     is 2750 `agentbox:devopscred`, so the group comes from the setgid directory rather than from a
 *     chgrp here, and the root itself is only 0751 — traversable, not readable.
 *
 * The directory must already exist. docker/agentbox-entrypoint.sh creates all three type directories
 * and asserts their owner and mode fatally before the node process starts, so a missing one means this
 * is not an AgentBox credential tree. Creating it here instead would produce a 0700 `agentbox:agentbox`
 * directory that the reader cannot enter, and the only symptom would be a permission error one process
 * boundary away from anything that could explain it.
 */
export function registerDevopsCredential(
  credentialsDir: string,
  opts: RegisterDevopsCredentialOpts,
): { entry: CredentialManifestEntry } {
  const endpoint = requireSingleLine(opts.endpoint, "endpoint");
  const project = requireSingleLine(opts.project, "project");
  const token = requireSingleLine(opts.token, "token");

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (err) {
    throw new Error(`endpoint is not a URL: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`endpoint must be http(s), got "${url.protocol}"`);
  }

  const safe = safeName(opts.name);
  const typeDir = resolveUnderDir(credentialsDir, DEVOPS_CREDENTIAL_SUBDIR);
  if (!fs.existsSync(typeDir)) {
    throw new Error(
      `${typeDir} does not exist — a project-agent credential can only land in an AgentBox credential ` +
      `tree, where docker/agentbox-entrypoint.sh creates it as agentbox:devopscred mode 2750. ` +
      `Creating it here would leave the reader unable to enter it.`,
    );
  }

  const filename = `${DEVOPS_CREDENTIAL_SUBDIR}/${safe}.json`;
  // The token lives in the file and nowhere else: not in the manifest metadata, not in the return
  // value, not in any message this function can raise.
  writeCredentialFile(
    credentialsDir,
    filename,
    JSON.stringify({ endpoint, project, token }, null, 2) + "\n",
    DEVOPS_CREDENTIAL_MODE,
  );

  const entry: CredentialManifestEntry = {
    name: opts.name,
    type: "devops_agent",
    description: opts.description ?? null,
    files: [filename],
    metadata: { endpoint, project },
  };

  const manifest = readManifest(credentialsDir).filter((e) => e.name !== opts.name);
  manifest.push(entry);
  writeManifest(credentialsDir, manifest);

  return { entry };
}

// ---------------------------------------------------------------------------
// Test-only exports (not part of public API)
// ---------------------------------------------------------------------------

/** @internal Exposed for unit testing only. */
export const _testing = { safeName, sanitizeSshField, readManifest, requireSingleLine };
