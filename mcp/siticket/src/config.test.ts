import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const base = { SITICKET_API_URL: "https://ticket.example.com", SITICKET_API_TOKEN: "t" };

describe("loadConfig", () => {
  it("accepts an HTTPS base URL and strips the trailing slash", () => {
    const config = loadConfig({ ...base, SITICKET_API_URL: "https://ticket.example.com/" });
    expect(config.baseUrl).toBe("https://ticket.example.com");
  });

  it("allows plain HTTP to a cluster-internal service name", () => {
    // The deployed shape: this server runs in an AgentBox beside Siticket.
    for (const host of ["siticket-apiserver:8080", "siticket-apiserver.sendong.svc", "st.ns.svc.cluster.local"]) {
      expect(loadConfig({ ...base, SITICKET_API_URL: `http://${host}` }).baseUrl).toBe(`http://${host}`);
    }
    // A public suffix still travels, so it still requires TLS.
    expect(() => loadConfig({ ...base, SITICKET_API_URL: "http://ticket.example.com" })).toThrow(ConfigError);
  });

  it("allows plain HTTP only for loopback development", () => {
    expect(loadConfig({ ...base, SITICKET_API_URL: "http://127.0.0.1:8080" }).baseUrl).toBe(
      "http://127.0.0.1:8080",
    );
    expect(() => loadConfig({ ...base, SITICKET_API_URL: "http://ticket.example.com" })).toThrow(
      ConfigError,
    );
  });

  it("treats an IPv6 literal as an address, not a cluster-internal name", () => {
    // URL keeps the brackets in `hostname`, so a literal has no dot and would
    // otherwise pass the single-label test.
    expect(loadConfig({ ...base, SITICKET_API_URL: "http://[::1]:8080" }).baseUrl).toBe("http://[::1]:8080");
    for (const host of ["[2001:db8::1]:8080", "[::ffff:8.8.8.8]", "[fd00::1]"]) {
      expect(() => loadConfig({ ...base, SITICKET_API_URL: `http://${host}` })).toThrow(ConfigError);
    }
    expect(loadConfig({ ...base, SITICKET_API_URL: "https://[2001:db8::1]" }).baseUrl).toBe("https://[2001:db8::1]");
  });

  it("refuses a URL carrying credentials or a query string", () => {
    expect(() => loadConfig({ ...base, SITICKET_API_URL: "https://u:p@ticket.example.com" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, SITICKET_API_URL: "https://ticket.example.com/?a=1" })).toThrow(
      ConfigError,
    );
  });

  it("requires exactly one token source", () => {
    expect(() => loadConfig({ SITICKET_API_URL: base.SITICKET_API_URL })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base, SITICKET_API_TOKEN_FILE: "/tmp/whatever" }),
    ).toThrow(ConfigError);
  });

  it("carries an optional ticket pin and bounds the timeout", () => {
    expect(loadConfig({ ...base, SITICKET_TICKET_ID: " t-1 " }).pinnedTicketId).toBe("t-1");
    expect(loadConfig(base).pinnedTicketId).toBeUndefined();
    expect(loadConfig({ ...base, SITICKET_TIMEOUT_MS: "5000" }).requestTimeoutMs).toBe(5000);
    expect(() => loadConfig({ ...base, SITICKET_TIMEOUT_MS: "10" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SITICKET_TIMEOUT_MS: "1.5" })).toThrow(ConfigError);
  });
});
