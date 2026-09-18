import type { SiticketConfig } from "./config.js";

/** Siticket answers every OpenAPI call with this envelope. `code` 0 is success. */
interface Envelope {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

/** Business codes we translate rather than pass through verbatim. */
export const CODE_INVALID_PARAM = 40001;
export const CODE_NOT_FOUND = 40401;
/** Siticket's "not ready yet, come back" code. Its body carries retryable: true. */
export const CODE_NOT_READY = 40901;
export const CODE_EXTERNAL = 50201;

/**
 * Siticket's own published ceiling, per token. Stated in the retry advice
 * because the obvious reaction to "retryable" is to retry immediately, and a
 * polling agent that does so spends its whole budget inside one backoff.
 */
export const REQUESTS_PER_MINUTE = 60;

export class SiticketError extends Error {
  readonly code: number | undefined;
  readonly status: number | undefined;
  /** True only when Siticket itself said so; never inferred from a status code. */
  readonly retryable: boolean;
  constructor(message: string, options: { code?: number; status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "SiticketError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Turn an upstream failure into something the model can act on.
 *
 * The attachment case is the one worth spelling out. Siticket resolves every
 * attachment on the requested page before it answers, so an unreachable object
 * store fails the WHOLE call: the caller receives no messages at all. Reported
 * as a bare 502 it reads like "one image is missing", and an agent then reasons
 * about a conversation it never saw.
 */
function describeFailure(status: number, code: number | undefined, message: string, path: string): string {
  if (status === 401 || status === 403) {
    return "Siticket rejected the API credential for this request";
  }
  if (code === CODE_NOT_FOUND) {
    return message || "Siticket has no such ticket";
  }
  if (code === CODE_INVALID_PARAM) {
    return message || "Siticket refused the request parameters";
  }
  if (code === CODE_NOT_READY) {
    return `${message || "Siticket is still syncing this ticket's transcript"} — TRANSIENT: the transcript is not readable yet, and nothing about the ticket is wrong. Retry with exponential backoff rather than immediately; Siticket allows about ${REQUESTS_PER_MINUTE} requests per minute per token, so a tight retry loop spends the whole budget inside one wait. get_ticket still works meanwhile.`;
  }
  if (code === CODE_EXTERNAL && path.includes("chat-history")) {
    return `${message || "Siticket could not read an attachment"} — this page returned NO messages, not a message with a missing image. Retry later, or read the ticket with get_ticket meanwhile.`;
  }
  return message || `Siticket request failed with HTTP ${status}`;
}

/** Siticket answers a retryable condition with data: { retryable: true }. */
function readRetryable(data: unknown): boolean {
  const record = asRecord(data);
  return record?.retryable === true;
}

export class SiticketClient {
  constructor(
    private readonly config: SiticketConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(path: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const url = new URL(this.config.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          // The token never appears in an error, a log line or a tool result.
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      // fetch resolves at response headers; the same deadline must cover the body.
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SiticketError(`Siticket did not answer within ${this.config.requestTimeoutMs}ms`);
      }
      throw new SiticketError(`Siticket could not be reached: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    let envelope: Envelope | undefined;
    try {
      envelope = asRecord(JSON.parse(text));
    } catch {
      envelope = undefined;
    }
    if (!envelope) {
      throw new SiticketError(
        `Siticket returned a non-JSON response (HTTP ${response.status})`,
        { status: response.status },
      );
    }

    const code = typeof envelope.code === "number" ? envelope.code : undefined;
    const message = typeof envelope.message === "string" ? envelope.message : "";
    // A failed call can still arrive as HTTP 200: routes that have not opted into
    // standard HTTP statuses keep the five-digit code in the body only. The
    // business code therefore decides, not the status.
    if (!response.ok || code !== 0) {
      throw new SiticketError(describeFailure(response.status, code, message, path), {
        code,
        status: response.status,
        retryable: readRetryable(envelope.data),
      });
    }
    return envelope.data;
  }
}
