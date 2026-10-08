import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./mcp-client.js";
import { createModelOutputRedactor, redactModelJson, type SensitiveValueSource } from "../shared/model-output-redactor.js";
import { redactDataDocument } from "../tools/infra/kubectl-sanitize.js";
import { argumentPathSecurityError } from "../tools/infra/argument-path-security.js";
import { MCP_OPERATION_POLICY_ENV, resolveMcpToolRules, type McpToolRule } from "./mcp-operation-policy.js";

const POLICY_ENV = "SICLAW_MCP_READ_ONLY_TOOLS";
const RESOURCE_ENV = "SICLAW_MCP_READ_ONLY_RESOURCES";
const PROMPT_ENV = "SICLAW_MCP_READ_ONLY_PROMPTS";
const RESERVED_ENV = new Set([POLICY_ENV, RESOURCE_ENV, PROMPT_ENV, MCP_OPERATION_POLICY_ENV]);
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

export interface McpReadOnlyPolicy {
  tools: ReadonlySet<string>;
  resources: ReadonlySet<string>;
  prompts: ReadonlySet<string>;
  /** Only the baked renderer may return opaque images. Its input is sanitized. */
  trustedRenderer: boolean;
  toolRules?: ReadonlyMap<string, McpToolRule>;
}

function allowlist(value: unknown): Set<string> {
  if (value === undefined) return new Set();
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.length > 1000 || parsed.some(name =>
    typeof name !== "string" || !name || name.length > 4096 || name.includes("*") || /[\x00-\x1f]/.test(name))) {
    throw new Error("MCP read-only policy must contain exact names, without wildcards");
  }
  return new Set(parsed);
}

/** Binding a server is not blanket permission to run all its tools. Policy is
 * operator-owned config, never an annotation or a model-supplied argument.
 * Reserved env entries reuse the existing SiCore config/mount contract. */
export function resolveMcpReadOnlyPolicy(config: McpServerConfig): McpReadOnlyPolicy {
  const env = "env" in config ? config.env : undefined;
  const expectedRenderer = fileURLToPath(new URL("../../mcp/create-chart/dist/index.js", import.meta.url));
  const trustedRenderer = config.transport === "stdio" && config.command === "sudo" &&
    JSON.stringify(config.args) === JSON.stringify(["-E", "-u", "sandbox", "--", "node", expectedRenderer]);
  const toolRules = resolveMcpToolRules(env?.[MCP_OPERATION_POLICY_ENV]);
  const tools = toolRules ? new Set([...toolRules].filter(([, rule]) => rule.effect === "read").map(([name]) => name)) : allowlist(env?.[POLICY_ENV]);
  if (trustedRenderer && env?.[POLICY_ENV] === undefined && !toolRules) {
    tools.add("render_chart"); tools.add("render_mermaid");
  }
  return { tools, resources: allowlist(env?.[RESOURCE_ENV]), prompts: allowlist(env?.[PROMPT_ENV]), trustedRenderer, ...(toolRules ? { toolRules } : {}) };
}

export function mcpTransportEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(Object.entries(env).filter(([key]) => !RESERVED_ENV.has(key)));
}

/** Include every configured env/header value, short secrets, auth scheme body,
 * URL userinfo/query credentials and literal CLI arguments. Never log these. */
export function mcpSensitiveValues(servers: Record<string, unknown>): string[] {
  const values = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value) values.add(value); };
  for (const entry of Object.values(servers)) {
    if (!entry || typeof entry !== "object") continue;
    const config = entry as Record<string, unknown>;
    for (const field of ["env", "headers"]) {
      const map = config[field];
      if (!map || typeof map !== "object") continue;
      for (const [key, value] of Object.entries(map)) {
        if (RESERVED_ENV.has(key)) continue;
        add(value);
        if (typeof value === "string" && /^(?:Bearer|Basic)\s+/i.test(value)) {
          const body = value.replace(/^\S+\s+/, "");
          add(body);
          if (/^Basic\s/i.test(value)) {
            const decoded = Buffer.from(body, "base64").toString("utf8");
            add(decoded); if (decoded.includes(":")) add(decoded.slice(decoded.indexOf(":") + 1));
          }
        }
        if (typeof value === "string" && /cookie/i.test(key)) for (const part of value.split(";")) {
          if (part.includes("=")) add(part.slice(part.indexOf("=") + 1).trim());
        }
      }
    }
    if (typeof config.url === "string") {
      try {
        const url = new URL(config.url);
        add(decodeURIComponent(url.username)); add(decodeURIComponent(url.password));
        for (const value of url.searchParams.values()) add(value);
      } catch { /* Connection validation will reject the invalid URL. */ }
    }
    if (Array.isArray(config.args)) {
      const addArgument = (value: string) => {
        add(value);
        // Headers and authenticated URLs can be configured as CLI operands;
        // an upstream echo need not preserve the enclosing flag or header.
        const auth=/^(?:Authorization:\s*)?(Bearer|Basic)\s+(.+)$/i.exec(value);
        if(auth){
          add(auth[2]);
          if(auth[1].toLowerCase()==="basic"){
            const decoded=Buffer.from(auth[2],"base64").toString("utf8");add(decoded);
            if(decoded.includes(":"))add(decoded.slice(decoded.indexOf(":")+1));
          }
        }
        try{
          const url=new URL(value);add(decodeURIComponent(url.username));add(decodeURIComponent(url.password));
          for(const item of url.searchParams.values())add(item);
        }catch{ /* Ordinary CLI operands are not URLs. */ }
      };
      for (let index=0;index<config.args.length;index++) {
        const arg=config.args[index];if(typeof arg!=="string")continue;
        const previous=config.args[index-1];
        const credentialOperand=typeof previous==="string"&&/^--?[^=]*(?:api[-_]?key|token|secret|password|authorization|credential)[^=]*$/i.test(previous);
        if (arg.startsWith("-") && arg.includes("=")) addArgument(arg.slice(arg.indexOf("=") + 1));
        else if (credentialOperand || !arg.startsWith("-") && !path.isAbsolute(arg) && arg !== "node" && arg !== "sandbox") addArgument(arg);
      }
    }
  }
  return [...values];
}

export class McpModelSecurity {
  readonly redact: (text: string) => string;
  constructor(private readonly secrets: SensitiveValueSource = () => [], private readonly privateRoots: () => readonly string[] = () => []) {
    this.redact = createModelOutputRedactor(secrets);
  }

  arguments(value: unknown): void {
    const strings: string[] = [];
    let nodes = 0;
    const collect = (item: unknown, depth: number, key = ""): void => {
      if (++nodes > 100_000 || depth > 48) throw new Error("MCP arguments exceed the safety budget");
      if (typeof item === "string" && (item.includes("/") || /%25|%2f|%5c/i.test(item)
          || /path|file|directory|folder|root/i.test(key))) strings.push(item);
      else if (Array.isArray(item)) for (const entry of item) collect(entry, depth + 1, key);
      else if (item && typeof item === "object") for (const [name, entry] of Object.entries(item)) collect(entry, depth + 1, name);
    };
    collect(value, 0);
    const error = argumentPathSecurityError(strings, { privateRoots: this.privateRoots() });
    if (error) throw new McpError(ErrorCode.InvalidParams, error);
  }

  text(value: string): string {
    // Parse JSON before structural redaction, then redact exact values in each
    // string to preserve quote/newline escapes and JSON validity.
    try {
      const parsed: unknown = JSON.parse(value);
      const structural = redactDataDocument(JSON.stringify(parsed)).text;
      return JSON.stringify(redactModelJson(JSON.parse(structural), this.redact));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return this.redact(redactDataDocument(value).text);
    }
  }

  tool(tool: Tool, policy: McpReadOnlyPolicy, description?: string): Tool | undefined {
    if (!policy.tools.has(tool.name)) return undefined;
    const safe = redactModelJson({ name: tool.name, description: [description, tool.description].filter(Boolean).join("\n"),
      inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) }, this.redact);
    // Redacting names would change callable identity. Suppress instead.
    if (safe.name !== tool.name) return undefined;
    return { ...safe, annotations: { readOnlyHint: true, destructiveHint: false } };
  }

  result(raw: unknown, allowImages = false): CallToolResult {
    try {
      if (!raw || typeof raw !== "object" || Buffer.byteLength(JSON.stringify(raw)) > MAX_RESULT_BYTES) throw new Error("Invalid MCP result");
      const result = raw as CallToolResult;
      if (!Array.isArray(result.content)) throw new Error("Invalid MCP content");
      const content: CallToolResult["content"] = result.content.map(block => {
        if (block.type === "text") return { type: "text", text: this.text(block.text) };
        if (block.type === "resource" && "text" in block.resource) {
          return { type: "resource", resource: { uri: this.redact(block.resource.uri),
            text: this.text(block.resource.text), mimeType: "text/plain" } };
        }
        if (allowImages && block.type === "image" && /^image\/(png|jpeg)$/.test(block.mimeType) &&
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data)) {
          const bytes = Buffer.from(block.data, "base64");
          if (this.redact(bytes.toString("latin1")) !== bytes.toString("latin1")) throw new Error("Sensitive image payload");
          return { type: "image", data: block.data, mimeType: block.mimeType };
        }
        return { type: "text", text: "MCP opaque content suppressed by the output security policy." };
      });
      const structuredContent = result.structuredContent === undefined ? undefined
        : JSON.parse(this.text(JSON.stringify(result.structuredContent))) as Record<string, unknown>;
      return { content: content.length ? content : [{ type: "text", text: "(no output)" }],
        ...(structuredContent === undefined ? {} : { structuredContent }),
        ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}) };
    } catch {
      return { isError: true, content: [{ type: "text", text: "MCP output suppressed: sanitization failed or exceeded the safety budget." }] };
    }
  }
}
