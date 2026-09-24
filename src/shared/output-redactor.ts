/**
 * Output redaction module — last-line defense for credential leakage.
 *
 * Builds regex patterns from the credential payload (server URLs, file paths,
 * cluster internal names) and replaces them with [REDACTED] in outbound text
 * sent to the user via WebSocket.
 *
 * Applied to all outbound surfaces: WS stream, channel-bridge, and DB storage.
 */

export interface RedactionConfig {
  patterns: RegExp[];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CredentialManifest {
  name: string;
  type: string;
  files: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Build redaction patterns from credential payload, credentials directory path,
 * and any additional sensitive strings (e.g. API keys, provider URLs).
 */
export function buildRedactionConfig(
  manifest?: CredentialManifest[],
  credentialsDir?: string,
  sensitiveStrings?: string[],
): RedactionConfig {
  const patterns: RegExp[] = [];

  // Redact the credentials directory path and any sub-paths
  if (credentialsDir) {
    patterns.push(new RegExp(escapeRegex(credentialsDir) + "[^\\s\"']*", "g"));
  }

  if (manifest) {
    for (const cred of manifest) {
      // File names (relative paths within credentials dir)
      for (const file of cred.files) {
        patterns.push(new RegExp(escapeRegex(file), "g"));
      }

      // Metadata: server URLs, cluster internal names
      if (cred.metadata) {
        const clusters = (cred.metadata as Record<string, unknown>).clusters as
          Array<{ name: string; server?: string }> | undefined;
        if (clusters) {
          for (const c of clusters) {
            if (c.server) {
              patterns.push(new RegExp(escapeRegex(c.server), "g"));
            }
            // Redact cluster internal ID if it differs from the credential display name
            if (c.name && c.name !== cred.name) {
              patterns.push(new RegExp("\\b" + escapeRegex(c.name) + "\\b", "g"));
            }
          }
        }
      }
    }
  }

  // Extra sensitive strings (API keys, provider base URLs, etc.)
  if (sensitiveStrings) {
    for (const s of sensitiveStrings) {
      if (s && s.length >= 8) {
        patterns.push(new RegExp(escapeRegex(s), "g"));
      }
    }
  }

  // Always redact settings.json path references
  patterns.push(/\.siclaw\/config\/settings\.json/g);

  // Generic secret patterns — catch unknown tokens by format (defense-in-depth)
  for (const p of GENERIC_SECRET_PATTERNS) {
    patterns.push(p);
  }

  return { patterns };
}

/**
 * Shared helper: build a redaction config from a model-config-shaped object.
 * Both the web-chat RPC path and AgentBox-side delegation callbacks redact the
 * provider's apiKey + baseUrl from outbound text before persistence.
 */
export function buildRedactionConfigForModelConfig(
  modelConfig?: { apiKey?: string; baseUrl?: string },
  /**
   * Additional model configs whose secrets must ALSO be redacted.
   *
   * A sub-agent may run on a different provider than its parent (model tiering),
   * and then the parent's apiKey/baseUrl alone is the wrong redaction set: the
   * child's own credentials would pass through echoed tool output unmasked. The
   * union is taken rather than a replacement because a child can emit either
   * side's values.
   */
  ...alsoRedact: Array<{ apiKey?: string; baseUrl?: string } | undefined>
): RedactionConfig {
  const extras = [modelConfig, ...alsoRedact]
    .flatMap((config) => [config?.apiKey, config?.baseUrl])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  return buildRedactionConfig(undefined, undefined, extras);
}

// Generic "apiKey": "value" or "api_key": "value" in JSON output
const JSON_SECRET_FIELD_PATTERN =
  /(?<="(?:api[_-]?[Kk]ey|apikey|token|secret|password|access_key|secret_key)":\s*")[^"]{8,}(?=")/g;
// ENV assignment: API_KEY=value, SECRET_TOKEN=value (printenv/env output)
const ENV_SECRET_ASSIGNMENT_PATTERN =
  /\b(?:API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|SECRET_KEY|ACCESS_KEY|AWS_SECRET_ACCESS_KEY|TOKEN|SECRET_TOKEN|PASSWORD)=\S+/g;

/**
 * Built-in patterns for common secret/token formats.
 * Each regex uses a non-capturing group and global flag.
 * Patterns are designed to minimize false positives by requiring known prefixes
 * or structural markers.
 */
const GENERIC_SECRET_PATTERNS: RegExp[] = [
  // OpenAI / compatible: sk-<20+ chars>
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Slack tokens: xox[baprs]-
  /\bxox[baprs]-[A-Za-z0-9\-]{20,}\b/g,
  // Google AI: AIza
  /\bAIza[A-Za-z0-9\-_]{30,}\b/g,
  // Authorization header values
  /\bBearer\s+[A-Za-z0-9\-_.~+/]{20,}=*\b/g,
  // PEM private key blocks
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  JSON_SECRET_FIELD_PATTERN,
  ENV_SECRET_ASSIGNMENT_PATTERN,
];

/**
 * Values a secret-named field may hold without holding a secret: a reference
 * the client resolves itself ($VAR, ${VAR}, OpenCode's {env:VAR}) or a
 * documentation placeholder (<Your API Key>). Product docs and knowledge-base
 * answers print exactly these in copyable config; masking them breaks the
 * config without protecting anything.
 *
 * Each form is kept narrow because `printenv` output prints values already
 * expanded, so a literal secret can start with `$` or `<`:
 * - a bare `$NAME` must read as an environment variable name (upper case,
 *   letters before the first underscore), so `$Summer2024` or `$ABC123` redact;
 * - a placeholder must close its `>` and read as a description, not a value
 *   (see isPlaceholderBody), so `<MyProductionPassword123>` redacts;
 * - `${VAR:-default}` is not exempt because the default can be a literal.
 */
const SECRET_REFERENCE_VALUE =
  /^(?:\$[A-Z]+(?:_[A-Z0-9]+)*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{env:[A-Za-z_][A-Za-z0-9_]*\})$/;
const PLACEHOLDER = /^<([^<>"'\n]+)>$/;
// A placeholder at the start of an assignment value; `\S+` stops at its first space.
const LEADING_PLACEHOLDER = /^["']?<([^<>"'\n]+)>["']?(?=\s|$)/;

// Words that name what a placeholder stands for. A body must contain one: shape
// alone cannot tell `<your-api-key>` from a passphrase like `<correcthorsebatterystaple>`.
const PLACEHOLDER_WORDS = new Set([
  "access", "api", "apikey", "bearer", "credential", "credentials", "key", "pass", "passwd",
  "password", "secret", "token", "your",
]);
const PLACEHOLDER_CJK_WORDS = /密钥|令牌|密码|凭证|口令|你的|您的/u;

/**
 * A documentation placeholder describes the value instead of holding one. It
 * has a placeholder shape — several letter-only words (`Your API Key`), one
 * UPPER_SNAKE or lower-kebab name (`API_KEY`, `your-api-key`), or a CJK
 * description (`你的API密钥`), never a digit — and it names what it stands for
 * (PLACEHOLDER_WORDS as a whole word, or a CJK equivalent). Anything else reads
 * as a value and redacts.
 */
function isPlaceholderBody(body: string): boolean {
  const text = body.trim();
  if (/\d/.test(text)) return false;
  const shaped = /\s/.test(text)
    ? text.split(/\s+/).every((word) => /^[\p{L}_-]+$/u.test(word))
    : /^[A-Z]+(?:_[A-Z]+)*$/.test(text)
      || /^[a-z]+(?:[-_][a-z]+)*$/.test(text)
      || (/\p{Script=Han}/u.test(text) && /^[\p{L}_-]+$/u.test(text));
  if (!shaped) return false;
  return PLACEHOLDER_CJK_WORDS.test(text)
    || text.split(/[\s_\-\p{Script=Han}]+/u).some((word) => PLACEHOLDER_WORDS.has(word.toLowerCase()));
}

function isSecretReferenceValue(value: string): boolean {
  const unquoted = value.replace(/^(["'])(.*)\1$/s, "$2");
  const placeholder = PLACEHOLDER.exec(unquoted);
  return placeholder ? isPlaceholderBody(placeholder[1]) : SECRET_REFERENCE_VALUE.test(unquoted);
}

function startsWithPlaceholder(value: string): boolean {
  const placeholder = LEADING_PLACEHOLDER.exec(value);
  return placeholder !== null && isPlaceholderBody(placeholder[1]);
}

/**
 * Only the key-name heuristics may pass a reference through. Literal patterns
 * (configured credentials, token formats) always redact, whatever they look like.
 */
function isUnredactedReference(pattern: RegExp, match: string, offset: number, text: string): boolean {
  if (pattern === JSON_SECRET_FIELD_PATTERN) return isSecretReferenceValue(match);
  if (pattern === ENV_SECRET_ASSIGNMENT_PATTERN) {
    const valueStart = match.indexOf("=") + 1;
    return isSecretReferenceValue(match.slice(valueStart))
      || startsWithPlaceholder(text.slice(offset + valueStart));
  }
  return false;
}

/**
 * Replace all sensitive patterns in text with [REDACTED].
 */
export function redactText(text: string, config: RedactionConfig): string {
  if (config.patterns.length === 0) return text;

  let result = text;
  for (const pattern of config.patterns) {
    // Reset lastIndex for stateful (global) regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match: string, offset: number, whole: string) =>
      isUnredactedReference(pattern, match, offset, whole) ? match : "[REDACTED]");
  }
  return result;
}
