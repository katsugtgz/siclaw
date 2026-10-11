type Config = Record<string, unknown>;

/** Map trusted provider configuration, never a model-supplied URL or credential.
 * JWT claims supply a routing header only; OpenAI authenticates the bearer. */
export function nativeCodexModelProvider(config: Config, api?: string): Config {
  const base = typeof config.baseUrl === "string" ? config.baseUrl : "";
  let url: URL;
  try { url = new URL(base); } catch { throw new Error("Invalid Codex provider URL"); }
  const chatgpt = url.origin === "https://chatgpt.com" &&
    ["/backend-api", "/backend-api/", "/backend-api/codex", "/backend-api/codex/"].includes(url.pathname);
  if (api === "openai-codex-responses" && !chatgpt) throw new Error("Subscription authentication requires the official ChatGPT backend");
  if (!chatgpt) return {
    name: "Siclaw model", base_url: base,
    ...(config.authHeader === false ? {} : { env_key: "SICLAW_CODEX_MODEL_TOKEN" }),
    ...(config.headers && typeof config.headers === "object" && !Array.isArray(config.headers) ? { http_headers: config.headers } : {}),
    wire_api: "responses",
  };
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid subscription backend URL");
  let claims: Record<string, unknown>;
  try {
    const token = typeof config.apiKey === "string" ? config.apiKey : "";
    if (token.length > 32768 || token.split(".").length !== 3) throw new Error();
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch { throw new Error("Subscription access token metadata is invalid"); }
  const auth = claims?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const account = auth?.chatgpt_account_id;
  if (typeof account !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(account) ||
      typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
    throw new Error("Subscription access token is expired or missing its account identity");
  }
  return { name: "ChatGPT subscription", base_url: "https://chatgpt.com/backend-api/codex", wire_api: "responses",
    env_key: "SICLAW_CODEX_MODEL_TOKEN", requires_openai_auth: false, supports_websockets: false,
    http_headers: { "ChatGPT-Account-Id": account } };
}
