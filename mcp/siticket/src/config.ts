import { readFileSync, statSync } from "node:fs";

export interface SiticketConfig {
  baseUrl: string;
  token: string;
  /** When set, every tool refuses any other ticket. See README "Scoping". */
  pinnedTicketId?: string;
  requestTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// `hostname` is what URL parsing yields: IPv6 literals keep their brackets.
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Plain HTTP is also allowed to a name that only resolves inside a cluster.
 *
 * The first real deployment refused to start on this: the server runs in an
 * AgentBox beside Siticket, reaching it as `http://siticket-apiserver:8080`.
 * That is ordinary in-cluster traffic, not an unencrypted hop across the
 * internet, and requiring TLS there would mean issuing certificates for a
 * service that never leaves the pod network.
 *
 * The test is the shape of the name, not a list: a single label carries no
 * public suffix and cannot be resolved outside the cluster that defines it, and
 * `.svc` / `.svc.cluster.local` are Kubernetes' own service domains. A name with
 * a public suffix — `ticket.example.com` — is still refused, because that one
 * really would travel. An IPv6 literal is an address, not a name: it has no dot
 * but may be anywhere, so it is refused here like any other address.
 */
function isClusterInternal(hostname: string): boolean {
  if (hostname === "" || hostname.startsWith("[") || hostname.includes("..") || hostname.endsWith(".")) return false;
  if (!hostname.includes(".")) return true;
  return hostname.endsWith(".svc") || hostname.endsWith(".svc.cluster.local");
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("SITICKET_API_URL must be an absolute URL");
  }
  if (url.username || url.password) {
    throw new ConfigError("SITICKET_API_URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new ConfigError("SITICKET_API_URL must not contain a query string or fragment");
  }
  const plainHttpAllowed = isLoopback(url.hostname) || isClusterInternal(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && plainHttpAllowed)) {
    throw new ConfigError(
      "SITICKET_API_URL must use HTTPS; plain HTTP is allowed only for loopback or a cluster-internal name",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function loadTokenFromFile(path: string): string {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new ConfigError("SITICKET_API_TOKEN_FILE could not be read");
  }
  if (!stat.isFile()) throw new ConfigError("SITICKET_API_TOKEN_FILE must point to a regular file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new ConfigError("SITICKET_API_TOKEN_FILE must not be readable or writable by group/others (use chmod 600)");
  }
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    throw new ConfigError("SITICKET_API_TOKEN_FILE could not be read");
  }
  if (!token) throw new ConfigError("SITICKET_API_TOKEN_FILE is empty");
  return token;
}

function loadToken(env: NodeJS.ProcessEnv): string {
  const direct = env.SITICKET_API_TOKEN?.trim();
  const file = env.SITICKET_API_TOKEN_FILE?.trim();
  if (direct && file) {
    throw new ConfigError("Set only one of SITICKET_API_TOKEN or SITICKET_API_TOKEN_FILE");
  }
  if (file) return loadTokenFromFile(file);
  if (direct) return direct;
  throw new ConfigError("SITICKET_API_TOKEN or SITICKET_API_TOKEN_FILE is required");
}

function parseBoundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SiticketConfig {
  const url = env.SITICKET_API_URL?.trim();
  if (!url) throw new ConfigError("SITICKET_API_URL is required");
  const pinned = env.SITICKET_TICKET_ID?.trim() || undefined;
  if (pinned && pinned.length > 64) {
    throw new ConfigError("SITICKET_TICKET_ID must be 64 characters or less");
  }
  return {
    baseUrl: normalizeBaseUrl(url),
    token: loadToken(env),
    pinnedTicketId: pinned,
    requestTimeoutMs: parseBoundedInteger(env, "SITICKET_TIMEOUT_MS", 30_000, 1_000, 120_000),
  };
}
