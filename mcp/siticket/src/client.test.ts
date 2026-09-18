import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SiticketClient, SiticketError } from "./client.js";
import type { SiticketConfig } from "./config.js";

const config: SiticketConfig = {
  baseUrl: "https://ticket.example.com",
  token: "sk-secret-value",
  requestTimeoutMs: 5000,
};

function answer(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("SiticketClient", () => {
  it("unwraps the envelope and forwards query parameters", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { ok: 1 } })));
    const client = new SiticketClient(config, impl as unknown as typeof fetch);
    await expect(client.get("/x", { a: "1", skipped: undefined, n: 2 })).resolves.toEqual({ ok: 1 });
    const url = new URL((impl.mock.calls[0] as unknown as [string])[0]);
    expect(url.pathname).toBe("/x");
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.get("n")).toBe("2");
    expect(url.searchParams.has("skipped")).toBe(false);
  });

  it("sends the token as a bearer header and never puts it in the URL", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: null })));
    await new SiticketClient(config, impl as unknown as typeof fetch).get("/x");
    const [url, init] = impl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("sk-secret-value");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-secret-value");
  });

  it("fails on a non-zero business code even when the HTTP status is 200", async () => {
    const client = new SiticketClient(config, answer({ code: 40401, message: "工单不存在" }));
    await expect(client.get("/x")).rejects.toThrow("工单不存在");
  });

  it("does not echo the credential when the request is rejected", async () => {
    const client = new SiticketClient(config, answer({ code: 40100, message: "unauthorized" }, 401));
    await expect(client.get("/x")).rejects.toThrow(/rejected the API credential/);
    await expect(client.get("/x")).rejects.not.toThrow(/sk-secret-value/);
  });

  it("states that an attachment failure cost the whole page, not one image", async () => {
    const client = new SiticketClient(
      config,
      answer({ code: 50201, message: "OSS is not configured" }, 502),
    );
    const error = await client.get("/openapi/ticket/customer_im/chat-history").catch((e) => e);
    expect(error).toBeInstanceOf(SiticketError);
    expect(error.message).toContain("OSS is not configured");
    expect(error.message).toContain("NO messages");
    expect(error.code).toBe(50201);
  });

  it("marks a still-syncing transcript retryable and says not to retry at once", async () => {
    const client = new SiticketClient(
      config,
      answer({ code: 40901, message: "聊天记录尚未完成本地同步，请稍后重试", data: { retryable: true } }, 409),
    );
    const error = await client.get("/openapi/ticket/customer_im/chat-history").catch((e) => e);
    expect(error.code).toBe(40901);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("TRANSIENT");
    expect(error.message).toContain("exponential backoff");
    expect(error.message).toContain("60 requests per minute");
    // The distinction that matters: nothing is wrong with the ticket itself.
    expect(error.message).toContain("get_ticket still works");
  });

  it("never infers retryable from a status code alone", async () => {
    const client = new SiticketClient(config, answer({ code: 50201, message: "boom" }, 502));
    await expect(client.get("/x").catch((e) => e.retryable)).resolves.toBe(false);
  });

  it("treats the business code as authoritative when a failure arrives as HTTP 200", async () => {
    const client = new SiticketClient(
      config,
      answer({ code: 40901, message: "still syncing", data: { retryable: true } }, 200),
    );
    const error = await client.get("/openapi/ticket/customer_im/chat-history").catch((e) => e);
    expect(error).toBeInstanceOf(SiticketError);
    expect(error.retryable).toBe(true);
  });

  it("reports a non-JSON answer as such rather than as empty data", async () => {
    const impl = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    const client = new SiticketClient(config, impl as unknown as typeof fetch);
    await expect(client.get("/x")).rejects.toThrow(/non-JSON response \(HTTP 502\)/);
  });

  it("reports a timeout as a timeout", async () => {
    const impl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const client = new SiticketClient(
      { ...config, requestTimeoutMs: 1000 },
      impl as unknown as typeof fetch,
    );
    await expect(client.get("/x")).rejects.toThrow(/did not answer within 1000ms/);
  });
});


it("keeps the deadline active while reading a slow response body", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"code":0,"data":');
    const timer = setTimeout(() => res.end('{"ok":true}}'), 250);
    res.once("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const client = new SiticketClient({ ...config, baseUrl: `http://127.0.0.1:${address.port}`, requestTimeoutMs: 50 });
    await expect(client.get("/slow-body")).rejects.toThrow("did not answer within 50ms");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
