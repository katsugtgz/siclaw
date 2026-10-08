import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import forge from "node-forge";
import { KubeConfig, Exec } from "@kubernetes/client-node";
import { dump } from "js-yaml";
import { parseArgs, shellEscape, isTrustedCommandExecutable, CONTAINER_SENSITIVE_PATHS } from "../tools/infra/command-sets.js";
import { preExecSecurity } from "../tools/infra/security-pipeline.js";
import { requireChannelNamespace, requireChannelOperation, type ChannelExecutionPolicy } from "../shared/channel-execution-policy.js";

export type KubernetesRequestScope = "discovery" | "query" | "logs" | "pod_exec" | "pod_metadata";

/** HTTP request authorization is independent of shell text and remains active
 * for immutable scripts. No writes, raw credentials, cross-namespace list/watch,
 * namespace discovery or privileged node transport escape this boundary. */
export function authorizeChannelKubernetesRequest(method: string, raw: string, policy: ChannelExecutionPolicy,
  trustedTransport?: {script:boolean}): KubernetesRequestScope {
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\x00-\x20\\#]/.test(raw)) throw new Error("Invalid Kubernetes request path");
  const url = new URL(raw, "http://broker.invalid");
  const parts = url.pathname.split("/").filter(Boolean).map(value => decodeURIComponent(value));
  if (parts.some(value => !/^[A-Za-z0-9_.:-]+$/.test(value) || value === "." || value === "..")) throw new Error("Invalid Kubernetes resource path");
  const discovery = ["/api", "/apis", "/version"].includes(url.pathname) ||
    /^\/api\/v[0-9]+(?:alpha[0-9]+|beta[0-9]+)?$/.test(url.pathname) || /^\/apis\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname);
  if (discovery) {
    if (method !== "GET" || [...url.searchParams.keys()].some(k=>k!=="timeout") ||
        !policy.operations.some(op=>["query","logs","pod_exec","scripts"].includes(op))) throw new Error("Kubernetes discovery request denied");
    return "discovery";
  }
  const start = parts[0] === "api" ? 2 : parts[0] === "apis" ? 3 : -1;
  if (start < 0 || parts.length <= start) throw new Error("Unknown Kubernetes API path");
  const namespaced = parts[start] === "namespaces" && parts.length > start + 2;
  if (!namespaced) {
    // Cluster-wide reads require a separate future reviewed contract. In
    // particular /pods across all namespaces is not a namespaced read.
    throw new Error("Cluster-wide Kubernetes requests are not authorized by a namespace-scoped policy");
  }
  const namespace = parts[start + 1];
  requireChannelNamespace(policy, namespace);
  const resource = parts[start + 2];
  if (["secrets", "serviceaccounts", "roles", "rolebindings", "tokenreviews", "subjectaccessreviews"].includes(resource))
    throw new Error("Sensitive Kubernetes resources are not authorized");
  const sub = parts[start + 4];
  if (resource === "pods" && sub === "exec") {
    requireChannelOperation(policy, trustedTransport?.script ? "scripts" : "pod_exec");
    if (!["GET", "POST"].includes(method) || parts.length !== start + 5 ||
        [...url.searchParams.keys()].some(key => !["command", "container", "stdin", "stdout", "stderr", "tty"].includes(key)) ||
        url.searchParams.get("tty") === "true" || url.searchParams.get("stdin") === "true" && !trustedTransport?.script ||
        ["container","stdin","stdout","stderr","tty"].some(key=>url.searchParams.getAll(key).length>1) ||
        ["stdin","stdout","stderr","tty"].some(key=>url.searchParams.has(key)&&!["true","false"].includes(url.searchParams.get(key)!)))
      throw new Error("Interactive Pod execution is not authorized");
    const args = url.searchParams.getAll("command");
    if (!args.length || args.some(arg => (trustedTransport ? /\x00/ : /[\x00-\x1f]/).test(arg))) throw new Error("Missing read-only Pod command");
    if(trustedTransport)return "pod_exec";
    // Do not join unquoted args into a different shell program. The whitelist
    // is the same one as the existing atomic Pod executor.
    if (!isTrustedCommandExecutable(args[0])) throw new Error("Pod binary is not a trusted executable");
    const command = [args[0], ...args.slice(1).map(shellEscape)].join(" ");
    if (!parseArgs(command).length || preExecSecurity(command, { context: "pod", blockPipeline: true, sensitivePathPatterns:CONTAINER_SENSITIVE_PATHS }).error)
      throw new Error("Pod command is not authorized by the read-only whitelist");
    return "pod_exec";
  }
  if (resource === "pods" && sub === "log") {
    requireChannelOperation(policy, "logs");
    if (method !== "GET" || parts.length !== start + 5) throw new Error("Pod log request denied");
    return "logs";
  }
  if (resource==="pods" && parts.length===start+4 && method==="GET" && !policy.operations.includes("query") &&
      policy.operations.some(op=>["logs","pod_exec","scripts"].includes(op))) return "pod_metadata";
  requireChannelOperation(policy, "query");
  if (method !== "GET" || parts.length > start + 4 || sub)
    throw new Error("Kubernetes write/subresource request denied");
  if (url.searchParams.has("watch") && !["false", "0"].includes(url.searchParams.get("watch") ?? ""))
    throw new Error("Unbounded Kubernetes watches are not authorized");
  return "query";
}

/** Broker-owned, credential-private per-grant API proxy. The only kubeconfig
 * materialized for scoped execution names this loopback endpoint and an opaque
 * token. Real upstream configuration remains in the trusted Node process. */
export class ChannelKubernetesProxy {
  private readonly transports=new Set<{namespace:string;pod:string;container:string;args:readonly string[];script:boolean;expires:number}>();
  private readonly cleanups=new Set<()=>void>();
  private readonly token = randomBytes(32).toString("hex");
  private readonly sockets = new Set<Socket>();
  private readonly upstreams = new Set<http.ClientRequest>();
  private server?: http.Server;
  private disposed = false;
  private config = new KubeConfig();
  private target?: URL;
  private certificate = "";
  constructor(private readonly policy: ChannelExecutionPolicy, private readonly validate: () => Promise<void>) {}

  async configure(realKubeconfig: string): Promise<string> {
    if (this.disposed) throw new Error("Channel Kubernetes proxy has ended");
    const config = new KubeConfig(); config.loadFromString(realKubeconfig);
    const cluster = config.getCurrentCluster();
    if (!cluster?.server) throw new Error("Missing authorized Kubernetes endpoint");
    const target = new URL(cluster.server);
    if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || target.search || target.hash)
      throw new Error("Unsupported Kubernetes endpoint");
    this.config = config; this.target = target;
    if (!this.server) {
      // client-go does not send bearer credentials over plaintext HTTP.
      // Generate an ephemeral loopback-only TLS identity. Its private key
      // stays in this trusted process; the synthetic config contains only CA.
      const pair=generateKeyPairSync("rsa",{modulusLength:2048,
        publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
      const certificate=forge.pki.createCertificate();certificate.publicKey=forge.pki.publicKeyFromPem(pair.publicKey);
      certificate.serialNumber="01"+randomBytes(15).toString("hex");
      certificate.validity.notBefore=new Date(Date.now()-60000);certificate.validity.notAfter=new Date(Date.now()+86400000);
      certificate.setSubject([{name:"commonName",value:"localhost"}]);certificate.setIssuer(certificate.subject.attributes);
      certificate.setExtensions([{name:"basicConstraints",cA:true},{name:"keyUsage",digitalSignature:true,keyEncipherment:true,keyCertSign:true},
        {name:"subjectAltName",altNames:[{type:7,ip:"127.0.0.1"}]}]);
      certificate.sign(forge.pki.privateKeyFromPem(pair.privateKey),forge.md.sha256.create());
      this.certificate=forge.pki.certificateToPem(certificate);
      this.server = https.createServer({key:pair.privateKey,cert:this.certificate},(req, res) => { void this.forward(req, res); });
      this.server.on("connection", socket => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
      this.server.on("upgrade", (req, socket, head) => { void this.upgrade(req, socket as Socket, head); });
      await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", resolve); });
    }
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Channel proxy is not listening");
    return dump({ apiVersion: "v1", kind: "Config", "current-context": "scoped",
      clusters: [{ name: "scoped", cluster: { server: `https://127.0.0.1:${address.port}`, "certificate-authority-data":Buffer.from(this.certificate).toString("base64") } }],
      contexts: [{ name: "scoped", context: { cluster: "scoped", user: "scoped", namespace: this.policy.namespaces[0] ?? "__denied__" } }],
      users: [{ name: "scoped", user: { token: this.token } }] });
  }

  private async authorize(req: IncomingMessage): Promise<KubernetesRequestScope> {
    if (this.disposed || !this.target) throw new Error("Channel proxy has ended");
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
    const expected = Buffer.from(this.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Channel proxy authentication denied");
    const url=new URL(req.url??"/","http://proxy");
    const matching=[...this.transports].find(t=>Date.now()<t.expires && url.pathname===`/api/v1/namespaces/${t.namespace}/pods/${t.pod}/exec` &&
      (!t.container || (url.searchParams.get("container")??"")===t.container) && JSON.stringify(url.searchParams.getAll("command"))===JSON.stringify(t.args));
    const scope=authorizeChannelKubernetesRequest(req.method ?? "", req.url ?? "", this.policy,matching);
    await this.validate();
    if (this.disposed) throw new Error("Channel proxy has ended");
    return scope;
  }

  private async options(req: IncomingMessage): Promise<https.RequestOptions> {
    const headers: http.OutgoingHttpHeaders = {};
    for (const key of ["accept", "content-type", "user-agent", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "x-stream-protocol-version"])
      if (req.headers[key]) headers[key] = req.headers[key];
    const options: https.RequestOptions = { method: req.method, headers,
      protocol: this.target!.protocol, hostname: this.target!.hostname, port: this.target!.port,
      path: this.target!.pathname.replace(/\/$/, "") + req.url, timeout: 30_000 };
    await this.config.applyToHTTPSOptions(options);
    return options;
  }

  private track(req: http.ClientRequest): void {
    this.upstreams.add(req); req.once("close", () => this.upstreams.delete(req));
    req.once("timeout", () => req.destroy(new Error("Scoped Kubernetes request timed out")));
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let stage="authorization";
    try {
      const scope=await this.authorize(req);
      if (req.headers.upgrade) throw new Error("Expected the dedicated upgrade path");
      stage="upstream-options";
      const options = await this.options(req);
      stage="upstream-request";
      if (scope==="pod_metadata") options.headers={...options.headers,accept:"application/json"};
      const upstream = (this.target!.protocol === "https:" ? https : http).request(options, response => {
        if (scope==="pod_metadata" && response.statusCode===200) {
          let size=0;const chunks:Buffer[]=[];
          response.on("data",chunk=>{size+=chunk.length;if(size>1024*1024)response.destroy();else chunks.push(Buffer.from(chunk));});
          response.once("error",()=>{res.writeHead(502).end();});
          response.once("end",()=>{
            try {
              const pod=JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if(pod.kind!=="Pod"||!pod.metadata||!pod.spec)throw new Error("Not a Pod");
              const names=(list:unknown)=>Array.isArray(list)?list.map(c=>({name:c.name})):[];
              const safe={apiVersion:pod.apiVersion,kind:"Pod",metadata:{name:pod.metadata.name,namespace:pod.metadata.namespace,uid:pod.metadata.uid,resourceVersion:pod.metadata.resourceVersion},
                spec:{containers:names(pod.spec.containers),initContainers:names(pod.spec.initContainers),ephemeralContainers:names(pod.spec.ephemeralContainers)},status:{phase:pod.status?.phase}};
              res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify(safe));
            }catch{res.writeHead(502).end();}
          });
          return;
        }
        // Upstream response headers can contain authentication challenges or
        // routing cookies. Neither is needed by kubectl, and neither is leaked.
        res.writeHead(response.statusCode ?? 502, { "content-type": response.headers["content-type"] ?? "application/json" });
        response.pipe(res);
      });
      this.track(upstream);
      upstream.once("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.once("close", () => upstream.destroy());
      // Authorized operations use URL query parameters, not caller bodies.
      upstream.end();
    } catch {
      // Static stage only: never log a URL, header, credential or SDK error.
      console.warn(`[channel-kubernetes-proxy] Request denied at ${stage}`);
      if (!res.headersSent) res.writeHead(403); res.end("Scoped Kubernetes operation denied");
    }
  }

  private async upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    try {
      if (await this.authorize(req) !== "pod_exec") throw new Error("Only Pod exec can upgrade");
      const options = await this.options(req);
      const upstream = (this.target!.protocol === "https:" ? https : http).request(options);
      this.track(upstream);
      upstream.once("upgrade", (response, remote, responseHead) => {
        this.sockets.add(remote); remote.once("close", () => this.sockets.delete(remote));
        const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
        for (const key of ["connection", "upgrade", "sec-websocket-accept", "sec-websocket-protocol", "x-stream-protocol-version"])
          if (response.headers[key]) lines.push(`${key}: ${response.headers[key]}`);
        socket.write(lines.join("\r\n") + "\r\n\r\n");
        if (responseHead.length) socket.write(responseHead);
        if (head.length) remote.write(head);
        remote.pipe(socket); socket.pipe(remote);
        socket.once("close", () => remote.destroy()); remote.once("close", () => socket.destroy());
      });
      upstream.once("response", () => socket.destroy()); upstream.once("error", () => socket.destroy());
      upstream.end();
    } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
  }

  dispose(): void {
    this.disposed = true;
    for(const cleanup of this.cleanups)cleanup();
    this.cleanups.clear();this.transports.clear();
    for (const req of this.upstreams) req.destroy();
    for (const socket of this.sockets) socket.destroy();
    this.server?.close(); this.upstreams.clear(); this.sockets.clear();
    this.config = new KubeConfig(); this.target = undefined;
    this.certificate="";
  }

  registerPodTransport(namespace:string,pod:string,container:string,args:readonly string[],script:boolean,cleanupArgs:readonly string[]):{finish:()=>void;kill:()=>void}{
    requireChannelNamespace(this.policy,namespace);requireChannelOperation(this.policy,script?"scripts":"pod_exec");
    if (this.disposed || !this.target) throw new Error("Scoped cluster transport has ended");
    if (this.transports.size >= 128) throw new Error("Too many scoped Pod transports");
    const config=this.config;let finished=false;
    const kill=()=>{
      if(finished)return;finished=true;
      void new Exec(config).exec(namespace,pod,container,[...cleanupArgs],null,null,null,false).then(socket=>{
        const timer=setTimeout(()=>socket.close(),15000);timer.unref();socket.once("close",()=>clearTimeout(timer));
      }).catch(()=>{});
    };
    const entry={namespace,pod,container,args:[...args],script,expires:Date.now()+15000};
    this.transports.add(entry);this.cleanups.add(kill);
    return {kill,finish:()=>{finished=true;this.transports.delete(entry);this.cleanups.delete(kill);}};
  }
}
