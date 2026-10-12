import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export type NativeOutputConsumer = (stream: "stdout" | "stderr", bytes: Uint8Array) => Promise<void>;

export async function consumeNativeOutput(stdout: Readable, stderr: Readable, output: NativeOutputConsumer): Promise<void> {
  const pump = async (input: Readable, stream: "stdout" | "stderr") => {
    for await (const bytes of input) await output(stream, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  };
  await Promise.all([pump(stdout, "stdout"), pump(stderr, "stderr")]);
}

/** Bounded by pipe backpressure, with no lifetime/output-size deadline. Native
 * cancellation owns process lifetime; an explicit reviewed-script timeout is
 * optional. Cleanup covers the detached process group even after parent exit. */
export async function spawnNativeStream(binary: string, args: string[], options: {
  cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal; stdin?: string;
  timeoutSeconds?: number; output: NativeOutputConsumer;
}): Promise<number> {
  options.signal.throwIfAborted();
  const child = spawn(binary, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
  options.signal.addEventListener("abort", kill, { once: true });
  const timer = options.timeoutSeconds === undefined ? undefined : setTimeout(kill, options.timeoutSeconds * 1000);
  child.stdin.on("error", () => {});
  child.stdin.end(options.stdin);
  const done = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
  if (options.signal.aborted) kill();
  try {
    const [code] = await Promise.all([done, consumeNativeOutput(child.stdout, child.stderr, options.output)]);
    return code;
  } catch (error) { kill(); await done.catch(() => {}); throw error; }
  finally { if (timer) clearTimeout(timer); options.signal.removeEventListener("abort", kill); }
}
