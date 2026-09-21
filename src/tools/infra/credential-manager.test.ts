import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEVOPS_CREDENTIAL_MODE,
  DEVOPS_CREDENTIAL_SUBDIR,
  registerDevopsCredential,
  _testing,
} from "./credential-manager.js";
import { resolveUnderDir } from "../../shared/path-utils.js";

const { safeName, sanitizeSshField, readManifest } = _testing;

// ---------------------------------------------------------------------------
// safeName
// ---------------------------------------------------------------------------

describe("safeName", () => {
  it("keeps alphanumeric, hyphens, and underscores", () => {
    expect(safeName("my-cluster_01")).toBe("my-cluster_01");
  });

  it("replaces special characters with underscores", () => {
    expect(safeName("prod@us-east/1")).toBe("prod_us-east_1");
  });

  it("trims leading and trailing underscores", () => {
    expect(safeName("...name...")).toBe("name");
  });

  it("throws on empty string", () => {
    expect(() => safeName("")).toThrow("at least one alphanumeric");
  });

  it("throws when all characters are special", () => {
    expect(() => safeName("@#$%")).toThrow("at least one alphanumeric");
  });
});

// ---------------------------------------------------------------------------
// sanitizeSshField
// ---------------------------------------------------------------------------

describe("sanitizeSshField", () => {
  it("passes clean values through", () => {
    expect(sanitizeSshField("192.168.1.1", "host")).toBe("192.168.1.1");
  });

  it("trims whitespace", () => {
    expect(sanitizeSshField("  root  ", "username")).toBe("root");
  });

  it("throws on empty value", () => {
    expect(() => sanitizeSshField("", "host")).toThrow("host must not be empty");
  });

  it("throws on whitespace-only value", () => {
    expect(() => sanitizeSshField("   ", "host")).toThrow("host must not be empty");
  });

  it("rejects newline injection", () => {
    expect(() => sanitizeSshField("evil.com\n  ProxyCommand nc attacker 1234", "host"))
      .toThrow("host must not contain newlines");
  });

  it("rejects carriage return injection", () => {
    expect(() => sanitizeSshField("evil.com\r\nProxyCommand bad", "host"))
      .toThrow("host must not contain newlines");
  });
});

// ---------------------------------------------------------------------------
// resolveUnderDir
// ---------------------------------------------------------------------------

describe("resolveUnderDir", () => {
  const credDir = "/tmp/test-creds";

  it("allows normal filenames", () => {
    expect(resolveUnderDir(credDir, "cluster.kubeconfig"))
      .toBe(path.join(credDir, "cluster.kubeconfig"));
  });

  it("blocks ../ traversal", () => {
    expect(() => resolveUnderDir(credDir, "../../../etc/passwd"))
      .toThrow("Path escapes base directory");
  });

  it("blocks absolute path escape", () => {
    expect(() => resolveUnderDir(credDir, "/etc/passwd"))
      .toThrow("Path escapes base directory");
  });
});

// ---------------------------------------------------------------------------
// readManifest
// ---------------------------------------------------------------------------

describe("readManifest", () => {
  it("returns empty array for non-existent directory", () => {
    expect(readManifest("/tmp/nonexistent-cred-dir-" + Date.now())).toEqual([]);
  });

  it("returns empty array for corrupted manifest", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "manifest.json"), "not json");
      expect(readManifest(tmpDir)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("returns empty array for non-array manifest", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "manifest.json"), '{"name":"bad"}');
      expect(readManifest(tmpDir)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("reads valid manifest", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-test-"));
    try {
      const entries = [{ name: "test", type: "kubeconfig", files: ["test.kubeconfig"] }];
      fs.writeFileSync(path.join(tmpDir, "manifest.json"), JSON.stringify(entries));
      expect(readManifest(tmpDir)).toEqual(entries);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// registerDevopsCredential
// ---------------------------------------------------------------------------

function makeCredentialTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-cred-devops-"));
  fs.mkdirSync(path.join(root, DEVOPS_CREDENTIAL_SUBDIR), { recursive: true });
  return root;
}

const OPTS = {
  name: "siforge",
  endpoint: "https://devops.example.internal",
  project: "demo-project",
  token: "sfm_0123456789abcdef",
};

describe("registerDevopsCredential", () => {
  it("writes the token into the type directory, group-readable for the setgid reader", () => {
    const root = makeCredentialTree();
    const { entry } = registerDevopsCredential(root, OPTS);

    expect(entry.files).toEqual([`${DEVOPS_CREDENTIAL_SUBDIR}/siforge.json`]);
    const file = path.join(root, entry.files[0]);
    // 0640, not the 0600 every other type here uses: `siforgectl` is not the owner of this file and
    // never will be — it reaches it through a setgid group, which is a group permission.
    expect(fs.statSync(file).mode & 0o777).toBe(DEVOPS_CREDENTIAL_MODE);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      endpoint: OPTS.endpoint,
      project: OPTS.project,
      token: OPTS.token,
    });
  });

  it("keeps the token out of the manifest — the entry says a credential exists, not what it is", () => {
    const root = makeCredentialTree();
    registerDevopsCredential(root, OPTS);

    const manifestText = fs.readFileSync(path.join(root, "manifest.json"), "utf8");
    expect(manifestText).not.toContain(OPTS.token);
    const [entry] = readManifest(root);
    expect(entry.type).toBe("devops_agent");
    expect(entry.metadata).toEqual({ endpoint: OPTS.endpoint, project: OPTS.project });
  });

  it("replaces its own manifest entry on re-registration rather than appending a second one", () => {
    const root = makeCredentialTree();
    registerDevopsCredential(root, OPTS);
    registerDevopsCredential(root, { ...OPTS, token: "sfm_rotated" });
    expect(readManifest(root)).toHaveLength(1);
  });

  it("refuses when the type directory is absent instead of creating an unreadable one", () => {
    // Creating it here would give 0700 agentbox:agentbox — a directory the setgid reader cannot enter,
    // failing one process boundary away from anything that could explain it.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-cred-bare-"));
    expect(() => registerDevopsCredential(bare, OPTS)).toThrow(/does not exist/);
  });

  it("refuses an endpoint that is not an http(s) URL", () => {
    const root = makeCredentialTree();
    expect(() => registerDevopsCredential(root, { ...OPTS, endpoint: "devops.example.internal" }))
      .toThrow(/not a URL/);
    expect(() => registerDevopsCredential(root, { ...OPTS, endpoint: "file:///etc/passwd" }))
      .toThrow(/must be http/);
  });

  it("refuses empty or multi-line values", () => {
    const root = makeCredentialTree();
    expect(() => registerDevopsCredential(root, { ...OPTS, token: "  " })).toThrow(/must not be empty/);
    expect(() => registerDevopsCredential(root, { ...OPTS, token: "sfm_a\nsfm_b" }))
      .toThrow(/must not contain newlines/);
    expect(() => registerDevopsCredential(root, { ...OPTS, project: "" })).toThrow(/must not be empty/);
  });

  it("cannot be steered out of the credential tree by its name", () => {
    const root = makeCredentialTree();
    const { entry } = registerDevopsCredential(root, { ...OPTS, name: "../../escape" });
    expect(entry.files[0]).toBe(`${DEVOPS_CREDENTIAL_SUBDIR}/escape.json`);
  });
});
