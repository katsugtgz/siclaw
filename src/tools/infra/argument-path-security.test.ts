import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { argumentPathSecurityError } from "./argument-path-security.js";
import { McpModelSecurity } from "../../core/mcp-security.js";

describe("shared script and MCP argument privacy", () => {
  it.each(["/etc/shadow", "/etc/../etc/shadow", "etc/shadow", "--file=/etc/shadow", "/etc/*",
    "/proc/1/environ", "/var/run/secrets/kubernetes.io/serviceaccount/token", "/root/.ssh/id_rsa",
    "file:///etc/shadow", "%2Fetc%2Fshadow", "%252Fetc%252Fshadow"])("rejects %s without reading or executing it", value => {
    expect(argumentPathSecurityError([value])).not.toBeNull();
  });
  it("blocks private broker roots and local symlink operands without blocking diagnostic arguments", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "argument-privacy-"));
    try {
      const credentials = path.join(root, "owner-private");
      fs.mkdirSync(credentials); fs.writeFileSync(path.join(credentials, "password"), "do-not-read");
      fs.symlinkSync(path.join(credentials, "password"), path.join(root, "alias"));
      const options = { cwd: root, privateRoots: [credentials] };
      expect(argumentPathSecurityError(["./alias"], options)).not.toBeNull();
      expect(argumentPathSecurityError([path.join(credentials, "password")], options)).not.toBeNull();
      expect(argumentPathSecurityError(["--unit", "kubelet", "--tail", "5", "--grep", "ERROR|reviewed", "/var/log/syslog"], options)).toBeNull();
      const security = new McpModelSecurity(() => [], () => [credentials]);
      expect(() => security.arguments({ path: path.join(credentials, "password") })).toThrow(/not authorized/);
      expect(() => security.arguments({ query: "**", filter: "id_rsa", namespace: "sicore-test" })).not.toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
