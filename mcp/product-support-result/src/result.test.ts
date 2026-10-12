import { describe, expect, it } from "vitest";
import { LIMITS, parseProductSupportResult } from "./result.js";

function emptyLlm(): Record<string, string> {
  return { region: "", aspect: "", model: "" };
}

function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: true,
    info: {
      ticket_type: "incident",
      product: "",
      summary: "Training task cannot start",
      description: "Task task-123 remains Pending after retry.",
      evidence: ["task_id=task-123", "status=Pending"],
      missing_fields: [],
      llm: emptyLlm(),
    },
    ...overrides,
  };
}

describe("parseProductSupportResult", () => {
  it("canonicalizes a ticket-ready result", () => {
    const result = parseProductSupportResult(
      validResult({
        info: {
          ticket_type: "incident",
          product: "  Example Product  ",
          summary: "  Task cannot start  ",
          description: "  task-123 remains Pending.  ",
          evidence: [" task_id=task-123 ", "task_id=task-123", " status=Pending "],
          missing_fields: [],
          llm: emptyLlm(),
        },
      }),
    );

    expect(result).toEqual({
      label: true,
      info: {
        ticket_type: "incident",
        product: "Example Product",
        summary: "Task cannot start",
        description: "task-123 remains Pending.",
        evidence: ["task_id=task-123", "status=Pending"],
        missing_fields: [],
        modules: [],
        llm: { region: "", aspect: "", model: "" },
      },
    });
  });

  it("accepts an incomplete non-handoff result", () => {
    const result = parseProductSupportResult({
      label: false,
      info: {
        ticket_type: "incident",
        product: "",
        summary: "",
        description: "A training task fails to start; the product and the error message are not known yet.",
        evidence: [],
        missing_fields: ["affected_product", "error_message"],
        llm: emptyLlm(),
      },
    });

    expect(result.label).toBe(false);
    expect(result.info.missing_fields).toEqual(["affected_product", "error_message"]);
  });

  it("requires a description on every turn, not only the handoff", () => {
    // The channel can hand the ticket to a human without another Agent turn,
    // so the latest result's description is what first-line support receives.
    for (const description of ["", "   "]) {
      const input = validResult({ label: false });
      input.info = { ...(input.info as Record<string, unknown>), summary: "", description };
      expect(() => parseProductSupportResult(input)).toThrow(/description must be non-empty on every turn/);
    }
  });

  it("does not require a summary before the handoff", () => {
    const input = validResult({ label: false });
    input.info = { ...(input.info as Record<string, unknown>), summary: "" };
    expect(parseProductSupportResult(input).info.summary).toBe("");
  });

  it("requires a concrete product for a ticket-ready requirement", () => {
    expect(() =>
        parseProductSupportResult(
          validResult({
            info: {
              ticket_type: "requirement",
              product: " ",
              summary: "Add an export API",
              description: "The team needs a CSV export API.",
              evidence: [],
              missing_fields: [],
              llm: emptyLlm(),
            },
          }),
        )).toThrow(/requires info\.product/);
  });

  it.each([true, false])("rejects an unknown ticket type (label=%s)", (label) => {
    // Every turn carries the most likely type; there is no unknown to fall back on.
    const input = validResult({ label });
    input.info = { ...(input.info as Record<string, unknown>), ticket_type: "unknown" };
    expect(() => parseProductSupportResult(input)).toThrow(/ticket_type must be one of: consultation, incident, llm_incident, requirement$/);
  });

  it("requires a boolean label", () => {
    expect(() => parseProductSupportResult({ ...validResult(), label: 1 })).toThrow(/label must be a boolean/);
  });

  it("requires a complete ticket title and description", () => {
    const input = validResult();
    input.info = {
      ...(input.info as Record<string, unknown>),
      summary: " ",
    };
    expect(() => parseProductSupportResult(input)).toThrow(/non-empty info\.summary/);
  });

  it("rejects ticket-ready results with missing information", () => {
    expect(() =>
        parseProductSupportResult(
          validResult({
            info: {
              ticket_type: "incident",
              product: "",
              summary: "Task failed",
              description: "Task task-123 failed.",
              evidence: [],
              missing_fields: ["error_message"],
              llm: emptyLlm(),
            },
          }),
        )).toThrow(/missing_fields to be empty/);
  });

  it("rejects user-facing questions and prose in missing fields", () => {
    // Both shapes a model reaches for instead of a machine identifier: an
    // English phrase with a space, and a non-ASCII question addressed to the user.
    for (const field of ["affected product", "受影响范围：请确认是否还有其他客户端失败"]) {
      const input = validResult({ label: false });
      input.info = {
        ...(input.info as Record<string, unknown>),
        missing_fields: [field],
      };
      expect(() => parseProductSupportResult(input)).toThrow(/lowercase snake_case field identifier/);
    }
  });

  it("checks identifier patterns on the value as sent, as the host does before dispatch", () => {
    const input = validResult({ label: false });
    input.info = { ...(input.info as Record<string, unknown>), missing_fields: [" module "] };
    expect(() => parseProductSupportResult(input)).toThrow(/missing_fields\[0\] must be a lowercase snake_case field identifier/);
  });

  it("rejects extra fields at both schema levels", () => {
    expect(() => parseProductSupportResult({ ...validResult(), action: "create_ticket" })).toThrow(/input\.action is not allowed/);

    const input = validResult();
    input.info = { ...(input.info as Record<string, unknown>), priority: "P0" };
    expect(() => parseProductSupportResult(input)).toThrow(/input\.info\.priority is not allowed/);
  });

  it("rejects blank evidence entries", () => {
    const input = validResult();
    input.info = { ...(input.info as Record<string, unknown>), evidence: [" "] };
    expect(() => parseProductSupportResult(input)).toThrow(/evidence\[0\] must not be blank/);
  });

  it("canonicalizes a ticket-ready llm_incident with its intake details", () => {
    const result = parseProductSupportResult(
      validResult({
        info: {
          ticket_type: "llm_incident",
          product: "",
          summary: "Chat completions return 429",
          description: "Calls to the model API return HTTP 429 since this morning.",
          evidence: ["HTTP 429", "model=example-model-v2"],
          missing_fields: [],
          llm: { region: "overseas", aspect: "model", model: "  example-model-v2 " },
        },
      }),
    );

    expect(result.info.ticket_type).toBe("llm_incident");
    expect(result.info.llm).toEqual({
      region: "overseas",
      aspect: "model",
      model: "example-model-v2",
    });
  });

  it("hands off an llm_incident with region and aspect, and no model unless the aspect is a model", () => {
    const result = parseProductSupportResult(
      validResult({
        info: {
          ticket_type: "llm_incident",
          product: "",
          summary: "Model API requests time out",
          description: "Every request to the domestic model API endpoint times out since 10:00.",
          evidence: ["timeout"],
          missing_fields: [],
          llm: { region: "domestic", aspect: "network", model: "" },
        },
      }),
    );

    expect(result.label).toBe(true);
    expect(result.info.llm).toEqual({ region: "domestic", aspect: "network", model: "" });
  });

  it.each([
    [{ region: "", aspect: "network", model: "" }, /requires info\.llm\.region and info\.llm\.aspect/],
    [{ region: "overseas", aspect: "", model: "" }, /requires info\.llm\.region and info\.llm\.aspect/],
    [{ region: "", aspect: "", model: "" }, /requires info\.llm\.region and info\.llm\.aspect/],
    [{ region: "overseas", aspect: "model", model: " " }, /aspect=model requires info\.llm\.model/],
  ])("rejects an llm_incident handoff without its routing facts: %j", (llm, re) => {
    const input = validResult();
    input.info = { ...(input.info as Record<string, unknown>), ticket_type: "llm_incident", llm };
    expect(() => parseProductSupportResult(input)).toThrow(re);
  });

  it("rejects an llm_incident handoff that omits the llm block", () => {
    const input = validResult();
    input.info = { ...(input.info as Record<string, unknown>), ticket_type: "llm_incident" };
    delete (input.info as Record<string, unknown>).llm;
    expect(() => parseProductSupportResult(input)).toThrow(/requires info\.llm\.region/);
  });

  it("keeps llm intake identifiers usable in missing_fields while still gathering", () => {
    const result = parseProductSupportResult({
      label: false,
      info: {
        ticket_type: "llm_incident",
        product: "",
        summary: "",
        description: "Model API calls return HTTP 401; the region and the failing aspect are not known yet.",
        evidence: ["HTTP 401"],
        missing_fields: ["llm_region", "llm_aspect"],
        llm: { region: "", aspect: "", model: "example-model-v2" },
      },
    });

    expect(result.info.missing_fields).toEqual(["llm_region", "llm_aspect"]);
    expect(result.info.llm.model).toBe("example-model-v2");
  });

  it("rejects region and aspect values outside the enum", () => {
    for (const llm of [
      { region: "eu", aspect: "", model: "" },
      { region: "", aspect: "billing", model: "" },
    ]) {
      const input = validResult({ label: false });
      input.info = { ...(input.info as Record<string, unknown>), ticket_type: "llm_incident", llm };
      expect(() => parseProductSupportResult(input)).toThrow(/must be empty or one of/);
    }
  });

  it("rejects llm intake details once the type has resolved to a non-LLM one", () => {
    for (const ticketType of ["incident", "consultation", "requirement"]) {
      const input = validResult({ label: false });
      input.info = {
        ...(input.info as Record<string, unknown>),
        ticket_type: ticketType,
        llm: { region: "domestic", aspect: "", model: "" },
      };
      expect(() => parseProductSupportResult(input)).toThrow(/unless ticket_type is llm_incident/);
    }
  });

  it("lets a gathering llm_incident record the details the user already stated", () => {
    const result = parseProductSupportResult({
      label: false,
      info: {
        ticket_type: "llm_incident",
        product: "",
        summary: "",
        description: "Domestic model API calls fail; the failing aspect is not known yet.",
        evidence: [],
        missing_fields: ["llm_aspect"],
        llm: { region: "domestic", aspect: "", model: "" },
      },
    });
    expect(result.info.llm.region).toBe("domestic");
  });

  it("mirrors the advertised schema: enum values are exact and length applies to the raw string", () => {
    // The host validates the advertised schema before dispatch on the primary
    // path, so the parser must not be more lenient than that schema.
    const enumInput = validResult({ label: false });
    enumInput.info = { ...(enumInput.info as Record<string, unknown>), ticket_type: " Incident " };
    expect(() => parseProductSupportResult(enumInput)).toThrow(/ticket_type must be one of/);

    const regionInput = validResult({ label: false });
    regionInput.info = {
      ...(regionInput.info as Record<string, unknown>),
      ticket_type: "llm_incident",
      llm: { region: "Overseas", aspect: "", model: "" },
    };
    expect(() => parseProductSupportResult(regionInput)).toThrow(/region must be empty or one of/);

    const lengthInput = validResult();
    lengthInput.info = {
      ...(lengthInput.info as Record<string, unknown>),
      summary: "x".repeat(LIMITS.summaryMaxChars) + "\n",
    };
    expect(() => parseProductSupportResult(lengthInput)).toThrow(/summary must be at most 200 characters/);
  });

  it("reports missing_fields errors at the caller's index, not the deduplicated one", () => {
    const input = validResult({ label: false });
    input.info = {
      ...(input.info as Record<string, unknown>),
      missing_fields: ["a", "a", "Bad Field"],
    };
    expect(() => parseProductSupportResult(input)).toThrow(/missing_fields\[2\] must be a lowercase snake_case/);
  });

  it("rejects oversized fields so the model can shorten them instead of losing the row", () => {
    const long = (n: number) => "x".repeat(n + 1);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ summary: long(LIMITS.summaryMaxChars) }, /summary must be at most 200 characters/],
      [{ description: long(LIMITS.descriptionMaxChars) }, /description must be at most 2000 characters/],
      [{ product: long(LIMITS.productMaxChars) }, /product must be at most 128 characters/],
      [{ evidence: Array.from({ length: LIMITS.evidenceMaxItems + 1 }, (_, i) => `e${i}`) }, /evidence must have at most 20 items/],
      [{ evidence: [long(LIMITS.evidenceItemMaxChars)] }, /evidence\[0\] must be at most 300 characters/],
      [{ missing_fields: Array.from({ length: LIMITS.missingFieldsMaxItems + 1 }, (_, i) => `f${i}`) }, /missing_fields must have at most 20 items/],
    ];
    for (const [patch, re] of cases) {
      const input = validResult({ label: false });
      input.info = { ...(input.info as Record<string, unknown>), ...patch };
      expect(() => parseProductSupportResult(input)).toThrow(re);
    }

    const model = validResult({ label: false });
    model.info = {
      ...(model.info as Record<string, unknown>),
      ticket_type: "llm_incident",
      llm: { region: "", aspect: "", model: long(LIMITS.modelMaxChars) },
    };
    expect(() => parseProductSupportResult(model)).toThrow(/llm\.model must be at most 128 characters/);
  });

  it("counts limits in characters, not bytes, so CJK text is not penalized", () => {
    const input = validResult();
    input.info = { ...(input.info as Record<string, unknown>), summary: "故".repeat(LIMITS.summaryMaxChars) };
    expect(parseProductSupportResult(input).info.summary.length).toBe(LIMITS.summaryMaxChars);
  });

  it("treats an absent llm block as all-empty and requires all three keys when present", () => {
    const absent = validResult();
    delete (absent.info as Record<string, unknown>).llm;
    expect(parseProductSupportResult(absent).info.llm).toEqual({ region: "", aspect: "", model: "" });

    const extra = validResult();
    extra.info = {
      ...(extra.info as Record<string, unknown>),
      llm: { region: "", aspect: "", model: "", vendor: "x" },
    };
    expect(() => parseProductSupportResult(extra)).toThrow(/input\.info\.llm\.vendor is not allowed/);

    const partial = validResult();
    partial.info = { ...(partial.info as Record<string, unknown>), llm: { region: "", aspect: "" } };
    expect(() => parseProductSupportResult(partial)).toThrow(/input\.info\.llm\.model is required/);
  });

  it("carries component tags at any level, deduplicated", () => {
    const input = validResult();
    input.info = {
      ...(input.info as Record<string, unknown>),
      modules: ["storage-object-upload", "billing", "storage-object-upload", "platform_ops"],
    };
    expect(parseProductSupportResult(input).info.modules).toEqual([
      "storage-object-upload",
      "billing",
      "platform_ops",
    ]);
  });

  it("treats absent or empty modules as no component established, even on a handoff", () => {
    const absent = validResult();
    delete (absent.info as Record<string, unknown>).modules;
    expect(parseProductSupportResult(absent).info.modules).toEqual([]);

    const empty = validResult({ label: false });
    empty.info = { ...(empty.info as Record<string, unknown>), modules: [] };
    expect(parseProductSupportResult(empty).info.modules).toEqual([]);
  });

  it("rejects values that are not module ids, at the caller's index", () => {
    // " billing " too: the host refuses it against the advertised pattern before
    // dispatch, so the parser must not quietly accept it on the other path.
    for (const bad of ["GPU Cloud", "gpu cloud", "1st-level", "-gpu", "日志服务", " billing ", "billing "]) {
      const input = validResult();
      input.info = { ...(input.info as Record<string, unknown>), modules: ["billing", bad] };
      expect(() => parseProductSupportResult(input)).toThrow(/input\.info\.modules\[1\] must be a module_id/);
    }
    const blank = validResult();
    blank.info = { ...(blank.info as Record<string, unknown>), modules: ["  "] };
    expect(() => parseProductSupportResult(blank)).toThrow(/input\.info\.modules\[0\] must not be blank/);
    const notArray = validResult();
    notArray.info = { ...(notArray.info as Record<string, unknown>), modules: "billing" };
    expect(() => parseProductSupportResult(notArray)).toThrow(/input\.info\.modules must be an array of strings/);
  });

  it("bounds component tags by count and id length", () => {
    const many = validResult();
    many.info = {
      ...(many.info as Record<string, unknown>),
      modules: Array.from({ length: LIMITS.modulesMaxItems + 1 }, (_, i) => `module-${i}`),
    };
    expect(() => parseProductSupportResult(many)).toThrow(/input\.info\.modules must have at most 10 items/);

    const long = validResult();
    long.info = { ...(long.info as Record<string, unknown>), modules: ["m" + "a".repeat(LIMITS.moduleIdMaxChars)] };
    expect(() => parseProductSupportResult(long)).toThrow(/input\.info\.modules\[0\] must be at most 64 characters/);
  });
});
