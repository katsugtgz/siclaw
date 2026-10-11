import type { IncomingMessage, ServerResponse } from "node:http";
import type { CertificateIdentity } from "./security/cert-manager.js";
import { matchesPrivateUser } from "./security/session-principal.js";
import { authorizeMcpArguments, mcpDigest } from "../core/mcp-operation-policy.js";
import { resolveMcpReadOnlyPolicy } from "../core/mcp-security.js";
import type { McpServerConfig } from "../core/mcp-client.js";
import { mcpConfigurationDigest, type McpOperation, type McpAuthorizationPermit } from "../shared/mcp-authorization.js";
import { identifier, record } from "../script-sandbox/validation.js";

type ControlPlane = { request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> };
/** Runtime derives caller from the LIVE authenticated Web turn and mTLS box.
 * Reuse the existing control-plane session/user and selected-resource pipeline.
 * Version 1 never issues write authority or falls back to a cached grant. */
export class NativeMcpAuthorization {
  constructor(private readonly control: ControlPlane,
    private readonly currentUser: (sessionId: string, agentId: string) => string,
    private readonly executionGrant?: (certificate: CertificateIdentity, sessionId: string, grantId: string) => import("./execution-grants.js").ExecutionGrant) {}

  async authorize(identity: CertificateIdentity, sessionId: string, operation: McpOperation, signal: AbortSignal, grantId?: string): Promise<McpAuthorizationPermit> {
    if (this.executionGrant && !grantId) throw new Error("MCP execution authorization required");
    const grant = grantId ? this.executionGrant?.(identity, sessionId, grantId) : undefined;
    if (grantId && !grant) throw new Error("MCP execution authorization required");
    if (grant && !grant.resources.policy && (grant.actor.kind === "none" || grant.actor.kind !== "user" && !grant.resources.clusters.length && !grant.resources.hosts.length))
      throw new Error("MCP identity has no authorized resources");
    const userId = grant ? grant.sender?.userId || (grant.actor.kind === "user" ? grant.actor.id : grant.resources.policy ? grant.sender?.openId || grant.actor.id : grant.actorUserId) : this.currentUser(sessionId, identity.agentId);
    if (!userId || !matchesPrivateUser(identity.privateUserId, userId)) throw new Error("Active MCP caller required");
    const checkCaller = () => {
      signal.throwIfAborted();
      if (grantId) {
        if (this.executionGrant?.(identity, sessionId, grantId) !== grant) throw new Error("MCP execution authorization changed");
      } else if (this.currentUser(sessionId, identity.agentId) !== userId) throw new Error("MCP caller changed");
    };
    checkCaller();
    if (!grant) {
      const owner = await this.control.request("sandbox.resolve", {
        agent_id: identity.agentId, session_id: sessionId, source: "", name: "",
      }, 10_000);
      if (!record(owner) || owner.user_id !== userId) throw new Error("MCP session authorization denied");
    }
    checkCaller();
    const resources = await this.control.request("config.getResources", { agentId: identity.agentId }, 5000);
    // No tenant rows is normal for published/preview inherited MCPs. Preserve
    // the shared materializer's empty selection semantics, never build a second store.
    const ids = record(resources) ? resources.mcp_server_ids ?? [] : undefined;
    if (!Array.isArray(ids) || ids.some(id => !identifier(id))) throw new Error("MCP bindings unavailable");
    const selected = await this.control.request("config.getMcpServers", { agentId: identity.agentId, ids }, 10_000);
    checkCaller();
    if (!record(selected) || !record(selected.mcpServers) || !Object.hasOwn(selected.mcpServers, operation.server)) throw new Error("MCP binding revoked");
    const config = selected.mcpServers[operation.server] as McpServerConfig;
    if (grant?.resources.policy) {
      const scope=grant.resources.policy;
      if(!scope.operations.includes("mcp")) throw new Error("Channel MCP operation is not authorized");
      const fresh=await this.control.request("channel.policy.resolve",{agentId:identity.agentId,sessionId,
        identity:{kind:grant.actor.kind,id:grant.actor.id},sender:grant.sender},5000);
      if(!record(fresh)||!record(fresh.policy)||fresh.policy.fingerprint!==scope.fingerprint) throw new Error("Channel MCP policy changed or was revoked");
      const rules=scope.version===2?scope.rules!.filter(r=>r.kind==='mcp').flatMap(r=>[...r.authority.mcp]):scope.mcp;
      const allowed=rules.some(rule=>{
        if(rule.serverId!==config.siclawId||!(operation.kind==="tool"?rule.tools:operation.kind==="resource"?rule.resources:rule.prompts).includes(operation.name))return false;
        if(operation.kind!=="tool")return true;
        return Object.entries(rule.arguments).every(([path,values])=>{
          let value:unknown=operation.arguments;
          for(const key of path.split("."))value=record(value)&&Object.hasOwn(value,key)?value[key]:undefined;
          return typeof value==='string'&&values.includes(value);
        });
      });
      if(scope.version!==3&&!allowed)throw new Error("Channel MCP tool or argument scope denied");
    }
    if (mcpConfigurationDigest(config) !== operation.configurationDigest) throw new Error("MCP configuration changed; rebuild the session");
    const policy = resolveMcpReadOnlyPolicy(config);
    let policyValue: unknown;
    if (operation.kind === "tool") {
      if (!policy.tools.has(operation.name)) throw new Error("MCP operation denied");
      const rule = policy.toolRules?.get(operation.name);
      // Authorization hashes the same effective args the local proxy will send.
      if (mcpDigest(authorizeMcpArguments(rule, operation.arguments)) !== mcpDigest(operation.arguments)) throw new Error("MCP argument scope mismatch");
      policyValue = rule ?? { effect: "read", name: operation.name };
    } else {
      const names = operation.kind === "resource" ? policy.resources : policy.prompts;
      if (!names.has(operation.name)) throw new Error("MCP operation denied");
      policyValue = { effect: "read", kind: operation.kind, name: operation.name };
    }
    checkCaller();
    return { protocol: 1, effect: "read", agentId: identity.agentId, userId, sessionId,
      server: operation.server, kind: operation.kind, name: operation.name,
      argumentsDigest: mcpDigest(operation.arguments), configurationDigest: operation.configurationDigest, policyDigest: mcpDigest(policyValue) };
  }

  async handle(req: IncomingMessage, res: ServerResponse, identity: CertificateIdentity | undefined): Promise<void> {
    const send = (status: number, value: unknown) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (!identity) { send(401, { error: "Client identity required" }); return; }
    const controller = new AbortController();
    const abort = () => controller.abort(); res.once("close", abort);
    const timer = setTimeout(() => { abort(); req.destroy(); }, 30_000);
    let operation: McpOperation | undefined; let sessionId = "";
    try {
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        controller.signal.throwIfAborted(); bytes += chunk.length;
        if (bytes > 256 * 1024) throw new Error("MCP authorization request too large");
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!record(body) || Object.keys(body).some(key => !["session_id", "operation", "grant_id", "channel_policy_v1", "channel_policy_v2", "channel_agent_scope"].includes(key)) || !identifier(body.session_id) || !record(body.operation)
          || body.grant_id !== undefined && !identifier(body.grant_id)) throw new Error("Invalid MCP authorization request");
      const raw = body.operation;
      if (Object.keys(raw).some(key => !["server", "kind", "name", "arguments", "callId", "configurationDigest"].includes(key)) ||
          typeof raw.server !== "string" || !raw.server || raw.server.length > 256 || /[\x00-\x1f]/.test(raw.server) || !["tool", "resource", "prompt"].includes(String(raw.kind)) ||
          typeof raw.name !== "string" || !raw.name || raw.name.length > 4096 || !record(raw.arguments) ||
          typeof raw.callId !== "string" || !raw.callId || raw.callId.length > 256 ||
          typeof raw.configurationDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.configurationDigest)) throw new Error("Invalid MCP operation");
      operation = raw as unknown as McpOperation; sessionId = body.session_id;
      if(body.grant_id && this.executionGrant?.(identity,sessionId,body.grant_id as string).resources.policy && body.channel_policy_v1!==true) throw new Error("AgentBox policy enforcement required");
      if(body.grant_id && this.executionGrant?.(identity,sessionId,body.grant_id as string).resources.policy?.version===2 && body.channel_policy_v2!==true) throw new Error("AgentBox resource-rule enforcement required");
      if(body.grant_id && this.executionGrant?.(identity,sessionId,body.grant_id as string).resources.policy?.version===3 && body.channel_agent_scope!==true) throw new Error("AgentBox Agent-resource enforcement required");
      const permit = await this.authorize(identity, sessionId, operation, controller.signal, body.grant_id as string | undefined);
      send(200, permit);
      console.info(JSON.stringify({ event: "native_mcp_authorization", decision: "allow", effect: permit.effect,
        agentId: permit.agentId, userId: permit.userId, sessionId, server: operation.server, kind: operation.kind,
        name: operation.name, callId: operation.callId, argumentsDigest: permit.argumentsDigest, policyDigest: permit.policyDigest }));
    } catch {
      send(403, { error: "MCP operation denied or authorization unavailable" });
      // Identifiers/names are not trusted log data on rejected requests. No
      // source arguments, code, URL, header, env or upstream error is audited.
      console.info(JSON.stringify({ event: "native_mcp_authorization", decision: "deny", agentId: identity.agentId }));
    } finally { clearTimeout(timer); res.off("close", abort); }
  }
}
