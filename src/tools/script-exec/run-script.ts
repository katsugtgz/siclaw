import { Type } from "@sinclair/typebox";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateScriptRequest } from "../../script-sandbox/validation.js";

export function createRunScriptTool(refs: ToolRefs): ToolDefinition {
  const info = refs.scriptSandboxInfo;
  const limits = info?.limits;
  const budget = limits
    ? `Per run: default ${limits.default_timeout_seconds}s, max ${limits.max_timeout_seconds}s after startup; ${limits.max_tool_calls} SDK calls; ${limits.max_output_bytes} stdout/stderr bytes. `
    : "Runtime budgets unavailable; use small batches and conservative timeouts. ";
  const network = info?.require_network_isolation ? "required" : info?.network_isolation ? "on by default" : "off by default";
  return {
    name: "run_script", label: "Run Script",
    // 描述的开头回答的是"要不要用",不是"怎么用"。判据写成情境而不是数量门槛:
    // 真正决定的是"同一个操作在重复、而你只要它们加起来的结论",不是目标有几个 ——
    // 4 个各跑 10 秒的检查值得来这里,20 个 kubectl get 用一条带 selector 的 bash 更好。
    // 数字只出现在【约束】段,回答"越界会怎样",因为那是模型必须拿来规划的硬限制。
    description: "Run Python stdlib or Bash in a disposable container to drive a batch of tool calls and turn their output into an answer before it reaches you. " +
      "Reach for it when the same operation repeats across targets and you only want what they add up to — the memory pressure across a node pool, which pods share a failing mount, how a setting differs between clusters. " +
      "Checking one node is a direct tool call; checking every node one by one costs a model round-trip each and fills your context with output you were only going to summarize. Do the looping and the summarizing here, and report the conclusion. " +
      "Also reach for it when the raw output is large but the answer is small, or when results from several places have to be joined before any of them mean anything. " +
      "Go direct for a single call, or when you need to read the raw output yourself — this returns what the script prints, not what the tools said. " +
      "Get one target right before you loop. Run the command once — as a direct tool call, or as the first SDK call whose result you read — and confirm the arguments, the authorization and the shape you are about to parse. A batch that is wrong is wrong N times, against N production targets, and you learn it only after paying for all of them. " +
      `Then keep the fan-out below what the target can absorb. These calls land on live infrastructure: ten concurrent kubectl calls are ten concurrent requests to one apiserver, and ten node commands are ten machines doing work for you. Concurrency is capped at ${limits?.max_concurrent_tools ?? 10}, but that is a ceiling, not a recommendation — size it to the target, stay near 2-3 against a single busy cluster or a production control plane, and only widen it when the work is spread across targets. The platform rate-limits per target as a backstop (queued, not rejected), which protects the platform rather than the cluster you are pointing at, and that queueing spends this script's budget. ` +
      budget +
      "One clock covers the whole run, and a batch that outruns it is killed where it stands — only what the script already printed comes back. Print each chunk's result as you go instead of holding everything for a final summary, and raise timeout_seconds up front when the batch is large. " +
      "Write the complete script from known tool schemas; avoid sandbox probes. Validate fields, catch per-resource errors, report successes and failures; do not retry denials or blindly repeat batches. " +
      "No production credentials, AgentBox/host files or package installation. /work and /tmp are writable scratch space within storage/memory limits; files vanish after this run. Image/SDK files are read-only. Local file processing needs no SDK. " +
      "Python: from siclaw import call, call_to_file, input_data. input_data() takes no arguments and returns decoded input JSON (None if omitted/null). Example for input {\"numbers\":[1,2,3]}: payload = input_data(); print(sum(payload[\"numbers\"])). " +
      "call(TOOL, ARGS) returns a result; call_to_file(TOOL, ARGS, '/work/result.json') saves the same sanitized JSON envelope and returns path/bytes/checksum. Shell: siclaw-tool TOOL JSON; siclaw-tool --output /work/result.json TOOL JSON; input is $SICLAW_INPUT_FILE. " +
      "Inline results: 128 KiB; files: 4 MiB each, 16 MiB/run. Process files here and print a concise final summary. File delivery retains tool output limits; logs are bounded windows. " +
      "Remote access uses existing Agent tools and their policies: bash {cluster,command,timeout_seconds?}, host_exec {host,command,timeout_seconds?}, node_exec {cluster,node,command,timeout_seconds?}, pod_exec {cluster,namespace?,pod,container?,command,timeout_seconds?}. " +
      "Declare bound clusters/hosts; these calls require run_commands. For kubectl, use bash. node_exec starts a diagnostic Job on each node — in a batch that is dozens of Jobs against the execution quota, so use it only when you actually need to be on the node. pod_exec requires timeout in the target container. " +
      "Command results: text (sanitized stdout), stderr, notices, exit_code, exit_class. Parse text for kubectl JSON; inspect exit_class/notices for completeness. Failed/truncated calls are rejected. " +
      "Python ToolError exposes code, execution, cleanup and optional result. UNKNOWN or cleanup=pending must not be automatically retried; RESULT_TOO_LARGE calls should use call_to_file. " +
      "MCP: use the main Agent's existing tool schemas. mcp__metrics__query maps to call('mcp.call', {'server':'metrics','tool':'query','arguments':{...}}), with mcp:[{server:'metrics',tools:['query']}] declared. tool is the original MCP name. SDK entry points are fixed; no discovery or generated wrappers. " +
      "MCP returns its native result directly, also at the saved file's JSON root: content, optional structuredContent and optional isError (absent means false). Check result.get('isError', False); prefer structuredContent, otherwise parse text content per tool schema. Do not search nested wrappers. " +
      "Every call/chunk reauthorizes the caller and declared resources; existing tool policies and credential RBAC apply. Use known bound names; ask if missing. Never embed secrets. " +
      `Network isolation: ${network}. When on, sockets (including subprocess SSH/HTTP) are denied; SDK uses local messages and runner stdio.`,
    parameters: Type.Object({
      language: Type.Union([Type.Literal("python"), Type.Literal("shell")]), code: Type.String({ maxLength: 131072 }),
      input: Type.Optional(Type.Unknown({
        description: "JSON value supplied to this script. Python reads it by calling input_data() with no arguments; Shell reads $SICLAW_INPUT_FILE. Omitted or null input becomes Python None.",
      })), network_isolation: Type.Optional(Type.Boolean()),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: limits?.max_timeout_seconds ?? 600,
        ...(limits ? { default: limits.default_timeout_seconds } : {}), description: "Execution budget after runner startup. Include target queue waits, concurrent SDK batches and diagnostic cleanup." })),
      clusters: Type.Optional(Type.Array(Type.Object({ name: Type.String() }, { additionalProperties: false }))),
      hosts: Type.Optional(Type.Array(Type.String())),
      mcp: Type.Optional(Type.Array(Type.Object({ server: Type.String(), tools: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false }))),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      if (!refs.scriptExecutor) throw new Error("Script sandbox unavailable");
      const result = await refs.scriptExecutor(validateScriptRequest(params), refs.sessionIdRef.current, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}

export const registration: ToolEntry = {
  category: "script-exec", create: createRunScriptTool,
  available: refs => !!refs.scriptExecutor && !refs.isSubagent,
  modes: ["web"],
};
