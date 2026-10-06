/** Fixed transport client launched by the native exec-server, never by a
 * model-visible tool. A one-use ticket selects an already validated operation. */
import { once } from "node:events";
const [endpoint, ticket] = process.argv.slice(2);
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
try {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/infrastructure") throw new Error();
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${ticket}` }, signal: stop.signal });
  if (!response.ok || !response.body) throw new Error();
  let pending = "", ended = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const bytes of response.body) {
    pending += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (line.length > 64 * 1024 || ended) throw new Error();
      const frame = JSON.parse(line);
      if (frame.stream === "stdout" || frame.stream === "stderr") {
        if (typeof frame.chunk !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.chunk)) throw new Error();
        const output = frame.stream === "stdout" ? process.stdout : process.stderr;
        if (!output.write(Buffer.from(frame.chunk, "base64"))) await once(output, "drain", { signal: stop.signal });
      } else if (frame.keepAlive === true) { /* Private transport liveness only. */ }
      else if (Number.isInteger(frame.exitCode)) { process.exitCode = frame.exitCode; ended = true; }
      else throw new Error();
    }
    if (pending.length > 64 * 1024) throw new Error();
  }
  if (pending || decoder.decode() || !ended) throw new Error();
} catch {
  process.stderr.write("Authorized native infrastructure execution failed.\n");
  process.exitCode = 1;
}
export {};
