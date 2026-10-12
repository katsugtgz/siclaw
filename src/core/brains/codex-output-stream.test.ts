import { describe, expect, it } from "vitest";
import { CodexOutputStream } from "./codex-output-stream.js";
import { analyzeOutput } from "../../tools/infra/output-sanitizer.js";
import { createModelOutputRedactor, SensitiveLiteralStream } from "../../shared/model-output-redactor.js";
import { redactDataDocument } from "../../tools/infra/kubectl-sanitize.js";

const bytes = (text: string) => Buffer.from(text);
describe("native output security framing", () => {
  it("streams complete ordinary records before exit, preserving UTF-8 across byte boundaries", () => {
    const stream = new CodexOutputStream();
    expect(stream.push(bytes("first\nsecond"))).toBe("first\n");
    const utf8 = bytes("你好\n");
    expect(stream.push(utf8.subarray(0, 2))).toBe("");
    expect(stream.push(utf8.subarray(2))).toBe("second你好\n");
    expect(stream.finish()).toBe("");
  });
  it("uses a live owner secret source and holds credentials split across chunks/lines", () => {
    const values = ["late-credential", "first\nsecond", "a+b"];
    const source = () => values;
    const stream = new CodexOutputStream(null, createModelOutputRedactor(source), source);
    expect(stream.push(bytes("healthy\nlate-"))).toBe("healthy\n");
    let safe = stream.push(bytes("credential\nfirst\n"));
    safe += stream.push(bytes("second\na%2Bb\n"));
    values.push("newly-acquired");
    safe += stream.push(bytes("newly-acquired\n")) + stream.finish();
    for (const value of [...values, "a%2Bb"]) expect(safe).not.toContain(value);
    expect(safe).toContain("REDACTED");
  });
  it("does not split overlapping credential matches at an output boundary", () => {
    const stream = new SensitiveLiteralStream(() => ["abc", "cd-long"]);
    const safe = stream.push("abc") + stream.push("d-long", true);
    expect(safe).not.toContain("abc"); expect(safe).not.toContain("cd-long");
  });
  it("carries PEM, YAML scalar and nested credential state between records", () => {
    const stream = new CodexOutputStream();
    let safe = stream.push(bytes("ok\nkey: -----BEGIN PRIVATE KEY-----\nprivate-body\n"));
    safe += stream.push(bytes("more-private\n-----END PRIVATE KEY-----\nsafe: yes\npassword: |\n  hidden-one\n"));
    safe += stream.push(bytes("  hidden-two\nvisible: yes\nsecret:\n  nested:\n    value: hidden-three\nlast: yes\n"));
    safe += stream.finish();
    for (const value of ["private-body", "more-private", "hidden-one", "hidden-two", "hidden-three"]) expect(safe).not.toContain(value);
    expect(safe).toContain("safe: yes"); expect(safe).toContain("last: yes");
  });
  it("redacts Pod YAML env values whose names occur in the previous record", () => {
    const stream = new CodexOutputStream();
    const safe = stream.push(bytes("  - name: API_TOKEN\n")) + stream.push(bytes("    value: unknown-secret\n  - name: SAFE\n    value: yes\n")) + stream.finish();
    expect(safe).not.toContain("unknown-secret"); expect(safe).toContain("value: yes");
  });
  it("protects quoted, folded and backslash-continued credential values", () => {
    const stream = new CodexOutputStream();
    let safe = stream.push(bytes('password: "hidden-one\n'));
    safe += stream.push(bytes('hidden-two"\nsafe: yes\napi_token: hidden-three\n  hidden-four\nvisible: yes\npassword=hidden-five\\\n'));
    safe += stream.push(bytes('hidden-six\nlast: yes\n  - name: API_TOKEN\n    value: "hidden-seven\n'));
    safe += stream.push(bytes('hidden-eight"\n  - name: SAFE\n    value: yes\n')) + stream.finish();
    expect(safe).not.toContain('hidden-'); expect(safe).toContain('safe: yes'); expect(safe).toContain('last: yes'); expect(safe).toContain('value: yes');
  });
  it("waits for JSON structure even when the Secret kind comes after its data", () => {
    const stream = new CodexOutputStream();
    expect(stream.push(bytes('{"data":{"arbitrary":"private-base64"},'))).toBe("");
    const safe = stream.push(bytes('"kind":"Secret"}\n')) + stream.finish();
    expect(safe).not.toContain("private-base64"); expect(JSON.parse(safe)).toMatchObject({ kind: "Secret" });
  });
  it.each(["json", "text"])("suppresses incomplete JSON in %s mode instead of leaking fragments", mode => {
    const action = mode === "json" ? analyzeOutput("kubectl", ["get", "secret", "-o", "json"]) : null;
    const stream = new CodexOutputStream(action);
    const safe = stream.push(bytes('{"data":{"arbitrary":"hidden-fragment')) + stream.finish();
    expect(safe).toContain("suppressed"); expect(safe).not.toContain("hidden-fragment");
  });
  it("handles a JSON array split at the opening byte, and ordinary log prefixes", () => {
    const stream = new CodexOutputStream();
    const safe = stream.push(bytes("[")) + stream.push(bytes('{"token":"private"}]\n[INFO] healthy\n')) + stream.finish();
    expect(safe).not.toContain("private"); expect(safe).toContain("[INFO] healthy");
  });
  it("protects arbitrary Secret data keys inside arrays and response envelopes", () => {
    const stream = new CodexOutputStream();
    const safe = stream.push(bytes('[{"response":{"data":{"unnamed":"hidden-array"},"kind":"Secret"}}]\n')) + stream.finish();
    expect(safe).not.toContain("hidden-array"); expect(JSON.parse(safe)[0].response.data.unnamed).toContain("REDACTED");
  });
  it.each([false, true])("redacts multiline environment values with NUL=%s", nul => {
    const stream = new CodexOutputStream(analyzeOutput("env", nul ? ["-0"] : []));
    const sep = nul ? "\0" : "\n";
    const safe = stream.push(bytes(`PASSWORD=hidden-a\n`)) + stream.push(bytes(`hidden-b${sep}SAFE=yes${sep}`)) + stream.finish();
    expect(safe).not.toContain("hidden-a"); expect(safe).not.toContain("hidden-b"); expect(safe).toContain("SAFE=yes");
  });
  it("suppresses a bare sensitive printenv value", () => {
    const stream = new CodexOutputStream(analyzeOutput("printenv", ["PASSWORD"]));
    expect(stream.push(bytes("bare\nsecret")) + stream.finish()).not.toMatch(/bare|secret/);
  });
  it("streams over 8 MiB without killing the process or keeping a process-sized buffer", () => {
    const stream = new CodexOutputStream();
    const line = "safe-log ".repeat(512) + "\n";
    let size = 0;
    for (let i = 0; i < 2200; i++) size += Buffer.byteLength(stream.push(bytes(line)));
    expect(size).toBe(Buffer.byteLength(line) * 2200); expect(size).toBeGreaterThan(8 * 1024 * 1024);
    expect(stream.finish()).toBe("");
  });
  it("discards only an oversized text/JSON record and resumes after its boundary", () => {
    const stream = new CodexOutputStream(null, text => text, () => [], 64);
    let safe = stream.push(bytes("x".repeat(100) + "\nhealthy\n"));
    safe += stream.push(bytes('{"password":"' + "x".repeat(100) + '"}\nafter\n')) + stream.finish();
    expect(safe).toContain("healthy"); expect(safe).toContain("after"); expect(safe).not.toContain("xxx");
  });
  it("continues after a JSON record exceeds its budget during formatting", () => {
    const stream = new CodexOutputStream(null, text => text, () => [], 64);
    const safe = stream.push(bytes('{"items":[1,2,3,4,5,6,7,8,9,10]}\nhealthy\n')) + stream.finish();
    expect(safe).toContain('suppressed'); expect(safe).toContain('healthy');
  });
  it("fails closed on malformed bytes and a failing credential source", () => {
    const utf8 = new CodexOutputStream();
    expect(utf8.push(new Uint8Array([0xff]))).toContain("suppressed"); expect(utf8.finish()).toBe("");
    const fail = new CodexOutputStream(null, text => text, () => { throw new Error("hidden error"); });
    expect(fail.push(bytes("private\n"))).toContain("suppressed"); expect(fail.finish()).toBe("");
  });
  it("keeps the generic redaction floor when no optional owner gate is supplied", () => {
    const stream = new CodexOutputStream();
    const token = 'ghp_' + 'a'.repeat(40);
    const safe = stream.push(bytes(`diagnostic ${token}\n`)) + stream.finish();
    expect(safe).not.toContain(token);
  });
  it("shares multiline protection with complete file/MCP/Pi documents", () => {
    const safe = redactDataDocument('password: "hidden-first\nhidden-second"\nsafe: yes\n');
    expect(safe.text).not.toContain('hidden-'); expect(safe.text).toContain('safe: yes'); expect(safe.redacted).toBe(true);
  });
  it("protects name/value credentials in generic complete documents", () => {
    const safe = redactDataDocument('{"spec":{"template":{"spec":{"containers":[{"env":[{"name":"API_TOKEN","value":"hidden-env"}]}]}}}}');
    expect(safe.text).not.toContain('hidden-env'); expect(safe.redacted).toBe(true); expect(()=>JSON.parse(safe.text)).not.toThrow();
  });
  it("requires new command-specific sanitizers to declare their stream contract", () => {
    const stream = new CodexOutputStream({type:"sanitize",lineSafe:false,sanitize:() => "safe"});
    expect(stream.push(bytes("private\n")) + stream.finish()).not.toContain("private");
  });
});
