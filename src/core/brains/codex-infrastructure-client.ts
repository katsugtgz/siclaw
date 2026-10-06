/** Fixed transport client launched by the native exec-server, never by a
 * model-visible tool. A one-use ticket selects an already validated operation. */
const [endpoint, ticket] = process.argv.slice(2);
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
try {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/infrastructure") throw new Error();
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${ticket}` }, signal: stop.signal });
  if (!response.ok) throw new Error();
  const result = await response.json() as { stdout: string; stderr: string; exitCode: number };
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 1;
} catch {
  process.stderr.write("Authorized native infrastructure execution failed.\n");
  process.exitCode = 1;
}
export {};
