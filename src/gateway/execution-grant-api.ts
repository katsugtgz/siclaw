import type { IncomingMessage, ServerResponse } from "node:http";
import type { CertificateIdentity } from "./security/cert-manager.js";
import type { CredentialService } from "./credential-service.js";

export async function handleExecutionGrantRenew(req: IncomingMessage, res: ServerResponse,
  certificate: CertificateIdentity, service: CredentialService): Promise<void> {
  const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  try {
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) throw new Error("Oversized grant request"); chunks.push(Buffer.from(chunk)); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some(key => !["grant_id", "session_id", "channel_policy_v1"].includes(key))
        || typeof body.grant_id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(body.grant_id)
        || typeof body.session_id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(body.session_id))
      throw new Error("Invalid grant request");
    send(200, await service.renewExecutionGrant({ ...certificate, grantId: body.grant_id, sessionId: body.session_id, channelPolicyV1: body.channel_policy_v1 === true }));
  } catch { send(403, { ok: false, reason: "unknown" }); }
}
