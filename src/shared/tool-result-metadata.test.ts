import { it, expect, vi, describe } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  persistableToolDetails,
  traceVisualIds,
  toolResultOutcome,
} from "./tool-result-metadata.js";
it("bounds IM link lookups to the same eight attachments accepted by Web", () => {
  const visuals = Array.from({ length: 20 }, (_, i) => ({
    visual_id: `v${i}`,
    kind: "chart",
    spec: { type: "waterfall", visual_id: `v${i}` },
  }));
  expect(traceVisualIds({ structuredContent: { schema_version: 2, visuals } }))
    .toEqual(visuals.slice(0, 8).map(v => v.visual_id));
});
it("nested details survive redaction and round trip without outcome flags", () => {
  const d = persistableToolDetails(
    {
      blocked: true,
      error: false,
      structuredContent: {
        schema_version: 2,
        visuals: [
          {
            visual_id: "v1",
            kind: "chart",
            spec: { type: "waterfall", visual_id: "v1", label: "secret" },
          },
        ],
      },
    },
    (s) => s.replaceAll("secret", "[REDACTED]"),
  );
  expect(d).not.toHaveProperty("blocked");
  expect(JSON.stringify(d)).toContain("[REDACTED]");
  expect(traceVisualIds(d)).toEqual(["v1"]);
});
it("invalid redacted JSON and untrusted ID mismatches fail closed", () => {
  expect(persistableToolDetails({ a: 1 }, () => "bad")).toBeNull();
  expect(
    traceVisualIds({
      structuredContent: {
        schema_version: 2,
        visuals: [
          {
            visual_id: "a",
            kind: "chart",
            spec: { type: "waterfall", visual_id: "b" },
          },
        ],
      },
    }),
  ).toEqual([]);
});

it("bounds UTF-8 and escaped JSON before synchronous redaction and after expansion", () => {
  const redact = vi.fn((text: string) => text);
  const metadata = persistableToolDetails({ skillPreview: { skill: { name: "large", specs: "界".repeat(400_000) } }, llm_round: 3 }, redact);
  expect(metadata).toMatchObject({ skillPreview: { status: "omitted", reason: "size_limit" }, llm_round: 3 });
  expect(redact.mock.calls[0][0].length).toBeLessThan(1000);
  expect(persistableToolDetails({ skillPreview: { skill: { name: "escaped", specs: "\u0000".repeat(180_000) } } })?.skillPreview).toMatchObject({ status: "omitted" });
  expect(persistableToolDetails({ skillPreview: { skill: { name: "expand", specs: "x".repeat(600_000) } } }, s => s.replaceAll("x", "xx"))?.skillPreview).toMatchObject({ status: "omitted" });
});


// ── toolResultOutcome: the SINGLE answer to "did this tool call fail" ───────────────

describe("toolResultOutcome", () => {
  it("reads the way tools ACTUALLY report failure, not just isError", () => {
    // 93 of the 94 failure returns under src/tools/ set `details`, and exactly one also sets
    // `isError`. A derivation that consults only `isError` therefore calls almost every real
    // failure a success -- which is what both agentbox persist paths did.
    expect(toolResultOutcome({ blocked: true }, false)).toBe("blocked");
    expect(toolResultOutcome({ error: true }, false)).toBe("error");
    expect(toolResultOutcome({ error: "no such artifact" }, false)).toBe("error");
    expect(toolResultOutcome(undefined, true)).toBe("error");
  });

  it("keeps blocked distinct from error — a refusal never ran, a failure did", () => {
    expect(toolResultOutcome({ blocked: true, error: true }, true)).toBe("blocked");
  });

  it("calls a success a success, including with no details at all", () => {
    expect(toolResultOutcome(undefined, undefined)).toBe("success");
    expect(toolResultOutcome({}, false)).toBe("success");
    expect(toolResultOutcome({ reason: "fine" }, false)).toBe("success");
    expect(toolResultOutcome("not an object", false)).toBe("success");
  });
});

// ── The invariant: nobody re-derives this by hand ───────────────────────────────────

describe("outcome derivation has exactly one implementation", () => {
  // It had two. The gateway called toolResultOutcome; agentbox spelled out
  // `isError ? "error" : "success"` -- the same judgement minus the `details` half -- and
  // both wrote the SAME column of the SAME table, so a refused command persisted as a
  // success for every delegated and every background turn.
  //
  // This project has been bitten by "one judgement, two implementations" before:
  // modelNeedsRebind (two copies, both missing the same field), session-origin.ts (eight
  // hand-written predicates, all eight missing 'subagent'), message-kinds.ts (four prompt
  // filters, each spelled out). A comment does not stop the fourth one; a failing test does.
  const SRC = fileURLToPath(new URL("..", import.meta.url));

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) yield* walk(full);
      // The canonical implementation is the one place the shape is allowed to appear.
      else if (full.endsWith(".ts") && !full.endsWith(".test.ts")
               && !full.endsWith("tool-result-metadata.ts")) yield full;
    }
  }

  it("no file re-implements the success/error ternary", () => {
    // Matches `<anything>isError ? "error" : "success"` and the `=== true` spelling, in any
    // quote style. The point is the SHAPE, not the variable name.
    const HAND_ROLLED = /\w*(?:isError|is_error)\b[^;\n]{0,40}\?\s*["'`]error["'`]\s*:\s*["'`]success["'`]/;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (HAND_ROLLED.test(line)) offenders.push(`${file.slice(SRC.length)}:${i + 1}`);
      });
    }
    expect(offenders, "derive it with toolResultOutcome(details, isError) instead").toEqual([]);
  });
});


describe("a tool that says it failed also SAYS so machine-readably", () => {
  // The twin of the invariant above, and neither is sufficient alone. That one keeps the
  // judgement to a single implementation; this one keeps there being anything to judge.
  // `text: "Error: ..."` is the sentence a human reads. `details.error` / `details.blocked`
  // is what the outcome column, the failure metrics, the retry logic and the trace UI read.
  // A return carrying only the first is a failure that every counter sees as a success —
  // which is precisely the state the persistence bug left every delegated turn in, and it
  // would be indistinguishable from the tool having no failures at all.
  const TOOLS = fileURLToPath(new URL("../tools/", import.meta.url));

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) yield* walk(full);
      else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) yield full;
    }
  }

  it("no tool return announces an error without a flag on it", () => {
    // Matches a return whose TEXT LITERAL opens with an error word — not a result that merely
    // happens to contain one, which is why the pattern is anchored to the start of the string.
    const ANNOUNCES = /text:\s*[`"'][\s]*(Error:|Failed|Cannot |Unable )|`Error: \$\{/;
    const FLAGGED = /details:\s*\{[^}]*\b(error|blocked)\b|isError/;
    const offenders: string[] = [];
    for (const file of walk(TOOLS)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/return\s*\{[^;]{0,800}?\};/gs)) {
        const block = match[0];
        if (!block.includes("content") || !ANNOUNCES.test(block)) continue;
        if (FLAGGED.test(block)) continue;
        offenders.push(`${file.slice(TOOLS.length)}:${text.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders, "add details:{error:true} (or blocked) — the sentence alone reaches no counter").toEqual([]);
  });
});
