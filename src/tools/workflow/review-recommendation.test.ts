import { describe, expect, it } from "vitest";
import { createReviewRecommendationTool } from "./review-recommendation.js";
import { persistableToolDetails } from "../../shared/tool-result-metadata.js";

describe("review recommendation", () => {
 it("persists bounded metadata once per turn through the shared recorder contract", async () => {
  const turnRef = { current: 1 }; const tool = createReviewRecommendationTool({ turnRef });
  const args = { analysis_recommendation: "high", reason_codes: ["unresolved"], confidence: "medium" };
  const result = await tool.execute("one", args);
  expect(persistableToolDetails(result.details)).toEqual({kind: "analysis_recommendation", ...args});
  expect((await tool.execute("two", args)).details).toEqual({duplicate: true});
  turnRef.current++;
  expect((await tool.execute("three", args)).details).toEqual({kind: "analysis_recommendation", ...args});
 });
 it("rejects arbitrary content and aborted writes", async () => {
  const tool=createReviewRecommendationTool({turnRef:{current:1}});
  await expect(tool.execute("bad", {analysis_recommendation:"high",reason_codes:["free text"],confidence:"high"})).rejects.toThrow();
  const ctrl=new AbortController();ctrl.abort();
  await expect(tool.execute("cancel", {analysis_recommendation:"low",reason_codes:[],confidence:"low"},ctrl.signal)).rejects.toThrow();
 });
});
