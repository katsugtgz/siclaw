import { postExecSecurity, type PreExecResult, type ToolOutputData } from "../../tools/infra/security-pipeline.js";

interface OutputChunk {
  seq: number;
  stream: "stdout" | "stderr";
  chunk: string;
}

interface ProcessOutput {
  security: PreExecResult;
  raw: Array<{ seq: number; stream: "stdout" | "stderr"; bytes: Buffer }>;
  seen: Set<number>;
  size: number;
  overflow: boolean;
  chunks: OutputChunk[];
  exited: boolean;
  exitCode: number | null;
  closed: boolean;
}

/** Native exec-server output gate. Raw chunks never become a model/UI result.
 * Complete-document buffering is the initial safe mode; streaming requires a
 * separate stateful sanitizer before the relay can enable long-running jobs. */
export class CodexExecutorOutput {
  private readonly processes = new Map<string, ProcessOutput>();

  constructor(private readonly maxBytes = 8 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid native output limit");
  }

  register(processId: string, security: PreExecResult): void {
    if (security.error || this.processes.has(processId)) throw new Error("Invalid native output registration");
    this.processes.set(processId, { security, raw: [], seen: new Set(), size: 0, overflow: false,
      chunks: [], exited: false, exitCode: null, closed: false });
  }

  capture(processId: string, seq: number, stream: string, encoded: string): void {
    const state = this.get(processId);
    if (state.exited || !Number.isSafeInteger(seq) || seq < 0 ||
        !["stdout", "stderr", "pty"].includes(stream)) throw new Error("Invalid native output chunk");
    if (state.seen.has(seq)) return;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error("Invalid native output encoding");
    }
    if (state.overflow) return;
    state.seen.add(seq);
    const bytes = Buffer.from(encoded, "base64");
    state.size += bytes.length;
    if (state.size > this.maxBytes || state.seen.size > 32_768) {
      state.overflow = true;
      state.raw = [];
      return;
    }
    if (!state.overflow) state.raw.push({ seq, stream: stream === "stderr" ? "stderr" : "stdout", bytes });
  }

  finish(processId: string, exitCode: number): readonly OutputChunk[] {
    const state = this.get(processId);
    if (state.exited) return state.chunks;
    let data: ToolOutputData;
    if (state.overflow) {
      data = { text: "Output suppressed: native execution exceeded the output safety limit.", stderr: "", notices: [] };
    } else {
      const raw = state.raw.sort((a, b) => a.seq - b.seq);
      const stdout = Buffer.concat(raw.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.bytes));
      const stderr = Buffer.concat(raw.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.bytes));
      let sanitized: ToolOutputData | undefined;
      try {
        postExecSecurity(stdout.toString("utf8"), state.security.action, {
          stderr: stderr.toString("utf8"), hasSensitiveKubectl: state.security.hasSensitiveKubectl,
          outputMode: "data", onOutputData: (value) => { sanitized = value; },
        });
      } catch {
        // A sanitizer failure must not reveal the unprocessed buffers.
      }
      data = sanitized ?? { text: "Output suppressed: native execution sanitization failed.", stderr: "", notices: [] };
    }
    state.raw = [];
    state.seen.clear();
    state.chunks = [];
    const text = [data.text, ...data.notices].filter(Boolean).join("\n");
    for (const [stream, value] of [["stdout", text], ["stderr", data.stderr]] as const) {
      const bytes = Buffer.from(value, "utf8");
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        state.chunks.push({ seq: state.chunks.length + 1, stream,
          chunk: bytes.subarray(offset, offset + 64 * 1024).toString("base64") });
      }
    }
    state.exited = true;
    state.exitCode = exitCode;
    return state.chunks;
  }

  close(processId: string): void {
    const state = this.get(processId);
    if (!state.exited) throw new Error("Native process closed before output was sanitized");
    state.closed = true;
  }

  read(processId: string, afterSeq = 0) {
    const state = this.get(processId);
    return { chunks: state.chunks.filter((chunk) => chunk.seq > afterSeq),
      nextSeq: state.chunks.length + Number(state.exited) + Number(state.closed),
      exited: state.exited, exitCode: state.exitCode,
      closed: state.closed, failure: null, sandboxDenied: false };
  }

  release(processId: string): void { this.processes.delete(processId); }

  private get(processId: string): ProcessOutput {
    const state = this.processes.get(processId);
    if (!state) throw new Error("Native output does not belong to this session");
    return state;
  }
}
