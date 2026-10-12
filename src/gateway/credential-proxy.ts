/**
 * HTTP handlers for AgentBox credential APIs (mTLS server, port 3002).
 *
 * Both handlers delegate to CredentialService, which — depending on config —
 * either queries the local clusters/agent_clusters DB or forwards to an
 * external credential provider. Identity is extracted from the mTLS client
 * certificate and cannot be spoofed.
 *
 *   POST /api/internal/credential-request  → one cluster's kubeconfig, one host's
 *                                            SSH material, or this agent's
 *                                            delivery-platform credential
 *   POST /api/internal/credential-list     → metadata for all bound clusters
 */

import http from "node:http";
import type { CertificateIdentity } from "./security/cert-manager.js";
import type { Identity } from "../shared/credential-types.js";
import { CredentialService, CredentialNotFoundError, SessionOwnershipError } from "./credential-service.js";

interface CredentialRequestBody {
  grant_id?: string;
  channel_policy_v1?: boolean;
  channel_policy_v2?: boolean;
  channel_agent_scope?: boolean;
  source?: string;
  source_id?: string;
  purpose?: string;
  session_id?: string;
}

interface CredentialListBody {
  channel_policy_v1?: boolean;
  channel_policy_v2?: boolean;
  channel_agent_scope?: boolean;
  grant_id?: string;
  kind?: string;
  session_id?: string;
  /** Host search (kind="host"): server-side filter + pagination. Absent = full list. */
  query?: string;
  limit?: number;
  cursor?: string;
}

// Keep identity fields to a safe charset before they land in SQL params or
// outbound HTTP headers. Node will reject CRLF in headers anyway, but we
// narrow further to prevent surprises (e.g. a non-UUID agentId slipping
// through and causing an unbounded DB scan).
const IDENTITY_CHARS = /^[A-Za-z0-9._\-@]{1,128}$/;

function assertSafeIdField(value: string, field: string): void {
  if (!IDENTITY_CHARS.test(value)) {
    throw new Error(`Invalid ${field} in client certificate`);
  }
}

/**
 * Turn an mTLS-verified cert identity into the `Identity` shape used by
 * `CredentialService`. `sessionId` (if provided in the request body) is
 * attached by the caller so the runtime can resolve it to an actual user
 * for audit attribution before calling Upstream.
 */
function toIdentity(cert: CertificateIdentity, sessionId?: string, grantId?: string, policyCapable?: boolean, rulesCapable?:boolean,agentScopeCapable?:boolean): Identity {
  assertSafeIdField(cert.agentId, "agentId");
  if (cert.orgId) assertSafeIdField(cert.orgId, "orgId");
  if (cert.boxId) assertSafeIdField(cert.boxId, "boxId");
  if (sessionId) assertSafeIdField(sessionId, "sessionId");
  if (grantId) assertSafeIdField(grantId, "grantId");
  return {
    agentId: cert.agentId,
    privateUserId: cert.privateUserId,
    orgId: cert.orgId,
    boxId: cert.boxId,
    sessionId,
    ...(grantId ? { grantId } : {}),
    channelPolicyV1: policyCapable === true,
    channelPolicyV2: rulesCapable === true,
    channelAgentScope: agentScopeCapable === true,
  };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  // Decode once on the stream: `chunk.toString()` per chunk decodes each fragment
  // on its own, so a multibyte character split across two chunks becomes two U+FFFD.
  req.setEncoding("utf8");
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export async function handleCredentialRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  service: CredentialService,
): Promise<void> {
  const raw = await readBody(req);
  let body: CredentialRequestBody;
  try {
    body = raw ? (JSON.parse(raw) as CredentialRequestBody) : {};
  } catch {
    sendError(res, 400, "Invalid JSON body");
    return;
  }

  if (body.source !== "cluster" && body.source !== "host" && body.source !== "devops") {
    sendError(res, 400, `Unsupported source: ${body.source ?? "(missing)"}`);
    return;
  }
  // source_id identifies WHICH cluster or host. `devops` has no which: an agent
  // carries exactly one delivery credential, keyed by the agentId in the mTLS
  // cert this handler already verified. Requiring an id here would force the
  // caller to invent one, and accepting one would create a selection the
  // management server has no second row to satisfy.
  if (body.source !== "devops" && !body.source_id) {
    sendError(res, 400, "source_id is required");
    return;
  }

  try {
    const id = toIdentity(identity, body.session_id, body.grant_id, body.channel_policy_v1, body.channel_policy_v2, body.channel_agent_scope);
    const purpose = body.purpose ?? "";
    let payload: unknown;
    if (body.source === "devops") {
      payload = await service.getDevopsCredential(id, purpose);
    } else if (body.source === "cluster") {
      payload = await service.getClusterCredential(id, body.source_id as string, purpose);
    } else {
      payload = await service.getHostCredential(id, body.source_id as string, purpose);
    }
    sendJson(res, 200, payload);
  } catch (err) {
    if (err instanceof SessionOwnershipError) {
      sendError(res, 403, err.message);
      return;
    }
    if (err instanceof CredentialNotFoundError) {
      sendError(res, 404, err.message);
      return;
    }
    console.error(`[credential-proxy] get${body.source}Credential failed:`, err);
    sendError(res, 502, err instanceof Error ? err.message : "Unknown error");
  }
}

export async function handleCredentialList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  service: CredentialService,
): Promise<void> {
  const raw = await readBody(req);
  let body: CredentialListBody;
  try {
    body = raw ? (JSON.parse(raw) as CredentialListBody) : {};
  } catch {
    sendError(res, 400, "Invalid JSON body");
    return;
  }

  if (body.kind !== "cluster" && body.kind !== "host") {
    sendError(res, 400, `Unsupported kind: ${body.kind ?? "(missing)"}`);
    return;
  }

  try {
    const id = toIdentity(identity, body.session_id, body.grant_id, body.channel_policy_v1,body.channel_policy_v2,body.channel_agent_scope);
    if (body.kind === "cluster") {
      const clusters = await service.listClusters(id);
      sendJson(res, 200, { clusters });
    } else {
      // A `query` (even "") routes to the filtered/paginated search (no full
      // snapshot); its absence keeps the full-list path the broker's reconcile
      // depends on.
      if (typeof body.query === "string") {
        const result = await service.queryHosts(id, body.query, { limit: body.limit, cursor: body.cursor });
        sendJson(res, 200, result);
      } else {
        const hosts = await service.listHosts(id);
        sendJson(res, 200, { hosts });
      }
    }
  } catch (err) {
    if (err instanceof SessionOwnershipError) {
      sendError(res, 403, err.message);
      return;
    }
    console.error(`[credential-proxy] list${body.kind} failed:`, err);
    sendError(res, 502, err instanceof Error ? err.message : "Unknown error");
  }
}
