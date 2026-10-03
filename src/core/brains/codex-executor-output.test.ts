import { describe, expect, it } from "vitest";
import { preExecSecurity } from "../../tools/infra/security-pipeline.js";
import { validateKubectlInPipeline } from "../../tools/infra/kubectl-readonly-policy.js";
import { CodexExecutorOutput } from "./codex-executor-output.js";

function security(command: string) {
  const checked = preExecSecurity(command, { context: "local", extraAllowed: new Set(["kubectl"]),
    pipelineValidators: [validateKubectlInPipeline], analyzeTarget: "auto" });
  expect(checked.error).toBeNull();
  return checked;
}
const encoded = (text: string) => Buffer.from(text).toString("base64");
const text = (chunks: readonly { chunk: string }[]) => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.chunk, "base64"))).toString();

describe("Codex native output policy", () => {
  it("withholds raw partial output and sanitizes a complete Secret before any native read", () => {
    const output = new CodexExecutorOutput();
    output.register("process-1", security("kubectl get secret test -o json"));
    output.capture("process-1", 1, "stdout", encoded('{"kind":"Secret","data":{"password":"bmF0aXZlLXNlY3JldA=="'));
    expect(output.read("process-1").chunks).toEqual([]);
    output.capture("process-1", 2, "stdout", encoded("}}"));
    const sanitized = text(output.finish("process-1", 0));
    expect(sanitized).not.toContain("bmF0aXZlLXNlY3JldA==");
    expect(sanitized).toContain("REDACTED");
    output.close("process-1");
    expect(output.read("process-1")).toMatchObject({ exited: true, closed: true, exitCode: 0 });
  });

  it("redacts stderr secrets split across native transport chunks", () => {
    const output = new CodexExecutorOutput();
    output.register("process-1", security("kubectl version --client"));
    output.capture("process-1", 1, "stderr", encoded("OPENAI_API_"));
    output.capture("process-1", 2, "stderr", encoded("KEY=sk-native-secret-for-test\n"));
    expect(text(output.finish("process-1", 1))).not.toContain("sk-native-secret-for-test");
  });

  it("suppresses oversized and malformed structural output without returning raw fragments", () => {
    const output = new CodexExecutorOutput(4);
    output.register("large", security("kubectl version --client"));
    output.capture("large", 1, "stdout", encoded("private raw value"));
    expect(text(output.finish("large", 0))).toContain("suppressed");
    expect(text(output.read("large").chunks)).not.toContain("private raw value");
    const malformed = new CodexExecutorOutput();
    malformed.register("json", security("kubectl get secret test -o json"));
    malformed.capture("json", 1, "stdout", encoded('{"kind":"Secret","data":{"password":"private-raw-fragment'));
    expect(text(malformed.finish("json", 1))).not.toContain("private-raw-fragment");
  });

  it("rejects unknown handles and invalid frames, and does not duplicate replayed chunks", () => {
    const output = new CodexExecutorOutput();
    expect(() => output.read("foreign")).toThrow(/session/);
    output.register("own", security("kubectl version --client"));
    expect(() => output.capture("own", 1, "stdout", "invalid-base64")).toThrow(/encoding/);
    output.capture("own", 1, "stdout", encoded("native-version"));
    output.capture("own", 1, "stdout", encoded("must-not-be-duplicated"));
    expect(text(output.finish("own", 0))).toBe("native-version");
    expect(output.read("own", 1).chunks).toEqual([]);
    output.release("own");
    expect(() => output.read("own")).toThrow(/session/);
  });
});
