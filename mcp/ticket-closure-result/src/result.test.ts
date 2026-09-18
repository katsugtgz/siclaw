import { describe, expect, it } from "vitest";
import { LIMITS, parseTicketClosureResult } from "./result.js";

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: "用户在控制台登录后持续返回 HTTP 500，重试三次可复现。受影响模块为控制台。",
    result_type: "控制台登录 500",
    result: "浏览器缓存的过期会话导致登录失败；清理站点数据后重新登录恢复，用户已确认可用。",
    ...overrides,
  };
}

describe("ticket closure result", () => {
  it("accepts the three fields and trims them", () => {
    const parsed = parseTicketClosureResult(valid({
      description: "  背景  ",
      result_type: "  登录异常  ",
      result: "  原因未确认  ",
    }));
    expect(parsed).toEqual({
      description: "背景",
      result_type: "登录异常",
      result: "原因未确认",
    });
  });

  it("keeps an honest undetermined cause", () => {
    const parsed = parseTicketClosureResult(valid({
      result_type: "登录异常（原因未确认）",
      result: "用户自行结单，未经排查确认原因；仅记录其自述已恢复。",
    }));
    expect(parsed.result_type).toBe("登录异常（原因未确认）");
  });

  it("requires every field", () => {
    for (const key of ["description", "result_type", "result"]) {
      const input = valid();
      delete input[key];
      expect(() => parseTicketClosureResult(input)).toThrow(`input.${key} is required`);
    }
  });

  it("rejects blank and whitespace-only fields", () => {
    for (const key of ["description", "result_type", "result"]) {
      expect(() => parseTicketClosureResult(valid({ [key]: "   " })))
        .toThrow(`input.${key} must not be blank`);
    }
  });

  it("rejects non-string fields", () => {
    expect(() => parseTicketClosureResult(valid({ result_type: 500 })))
      .toThrow("input.result_type must be a string");
  });

  it("rejects any field Siticket does not persist", () => {
    expect(() => parseTicketClosureResult(valid({ finish_time: "2026-09-17T00:00:00Z" })))
      .toThrow("input.finish_time is not allowed");
  });

  it("rejects a non-object input", () => {
    for (const input of [null, "x", 1, [valid()]]) {
      expect(() => parseTicketClosureResult(input)).toThrow("input must be an object");
    }
  });

  // Siticket renders result_type in a single-line control, so a newline cannot
  // survive the round trip even though the length check would pass.
  it("rejects line breaks in result_type only", () => {
    for (const breaker of ["\n", "\r", String.fromCodePoint(0x2028), String.fromCodePoint(0x2029)]) {
      expect(() => parseTicketClosureResult(valid({ result_type: `登录${breaker}异常` })))
        .toThrow("input.result_type must be a single line without line breaks");
    }
    expect(() => parseTicketClosureResult(valid({ result: "第一行\n第二行" }))).not.toThrow();
    expect(() => parseTicketClosureResult(valid({ description: "第一行\n第二行" }))).not.toThrow();
  });

  // Counted in code points so the bound matches Siticket's rune-based check;
  // a UTF-16 count would let a CJK value pass here and be refused there.
  it("counts characters, not UTF-16 units", () => {
    const limits: Array<[string, number]> = [
      ["description", LIMITS.descriptionMaxChars],
      ["result_type", LIMITS.resultTypeMaxChars],
      ["result", LIMITS.resultMaxChars],
    ];
    for (const [key, max] of limits) {
      expect(() => parseTicketClosureResult(valid({ [key]: "国".repeat(max) }))).not.toThrow();
      expect(() => parseTicketClosureResult(valid({ [key]: "国".repeat(max + 1) })))
        .toThrow(`input.${key} must be at most ${max} characters`);
      // Astral characters are one code point each, exactly as Go counts a rune.
      expect(() => parseTicketClosureResult(valid({ [key]: "𝄞".repeat(max) }))).not.toThrow();
    }
  });

  it("matches Siticket's published result_type cap", () => {
    expect(LIMITS.resultTypeMaxChars).toBe(256);
  });

  // Length is judged before trimming, exactly as a host applies the advertised
  // maxLength, so this parser is never more lenient than the schema the model saw.
  it("rejects on the raw length even when trimming would fit", () => {
    const padded = ` ${"国".repeat(LIMITS.resultTypeMaxChars)} `;
    expect(() => parseTicketClosureResult(valid({ result_type: padded })))
      .toThrow(`input.result_type must be at most ${LIMITS.resultTypeMaxChars} characters`);
  });
});
