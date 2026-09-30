import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { CapabilitiesRequiredError } from "../shared/capability-configuration.js";
import {
  AGENT_TYPES,
  COMPLETE_CATALOG_KNOWLEDGE_QA_DEFAULT_PROMPT,
  LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT,
  PRE_DISCOVERY_KNOWLEDGE_QA_DEFAULT_PROMPT,
  PREVIOUS_KNOWLEDGE_QA_DEFAULT_PROMPT,
  PRODUCT_SUPPORT_DEFAULT_PROMPT,
  CODING_DEFAULT_PROMPT,
  FLAT_TREE_CODING_DEFAULT_PROMPT,
  normalizeAgentType,
  requireAgentType,
  effectiveAgentPrompt,
  effectiveCapabilityKeys,
  resolveAgentPromptLayers,
} from "./agent-types.js";

describe("agent-types", () => {
  it("has the supported types; built-ins lock capabilities and own their runtime contracts", () => {
    expect(Object.keys(AGENT_TYPES).sort()).toEqual(["coding", "custom", "knowledge_qa", "product_support", "sre", "ticket"]);
    expect(AGENT_TYPES.sre.capabilities).toBeTruthy();
    expect(AGENT_TYPES.sre.defaultPrompt).toBeTruthy();
    expect(AGENT_TYPES.knowledge_qa.capabilities).toEqual([
      "read_files", "run_local_scripts", "write_sandbox", "plan_tasks", "session_output",
    ]);
    // Research is not delegated: a child of this type inherits the same read-only tools
    // and can only return model recall dressed as a verified result.
    expect(AGENT_TYPES.knowledge_qa.capabilities).not.toContain("spawn_subagents");
    expect(AGENT_TYPES.knowledge_qa.defaultPrompt).toBeTruthy();
    expect(AGENT_TYPES.knowledge_qa.defaultNoSkills).toBe(false);
    expect(AGENT_TYPES.product_support.capabilities).toEqual(["read_files"]);
    expect(AGENT_TYPES.product_support.defaultPrompt).toBe(PRODUCT_SUPPORT_DEFAULT_PROMPT);
    expect(AGENT_TYPES.product_support.defaultNoSkills).toBe(true);
    expect(AGENT_TYPES["coding"].defaultPrompt).toBe(CODING_DEFAULT_PROMPT);
    expect(AGENT_TYPES["coding"].defaultNoSkills).toBe(false);
    expect(AGENT_TYPES.custom.capabilities).toBeNull();
    expect(AGENT_TYPES.custom.defaultPrompt).toBeNull();
  });

  it("coding takes its capabilities from the host and refuses to run without them", () => {
    // The control plane's released type definition owns the selection (it is
    // the only place that can grant read_code); an empty delivery is not
    // "unrestricted" for this type.
    expect(AGENT_TYPES["coding"].capabilities).toBeNull();
    expect(() => effectiveCapabilityKeys("coding", null)).toThrow(CapabilitiesRequiredError);
    expect(() => effectiveCapabilityKeys("coding", [])).toThrow("Coding Agent requires explicit tool capabilities");
    expect(effectiveCapabilityKeys("coding", ["read_files", "read_code"])).toEqual(["read_files", "read_code"]);
  });

  it("the Portal mirror matches this registry (locked capabilities + description)", () => {
    // portal-web/src/lib/agentTypes.ts duplicates the locked capability lists and
    // descriptions for the type picker, and its own header says to keep them in
    // sync. It drifted once: the coordinator kept advertising "read-only router"
    // and `search_memory` after both changed here, which tells operators the
    // wrong thing about an agent they are configuring. Read as text rather than
    // imported so no build boundary is crossed, and resolved relative to THIS
    // file so a checked-out copy compares against its own sibling mirror.
    const mirror = readFileSync(
      new URL("../../portal-web/src/lib/agentTypes.ts", import.meta.url),
      "utf8",
    );
    for (const [key, def] of Object.entries(AGENT_TYPES)) {
      const block = mirror.split(`key: "${key}"`)[1]?.split("},")[0];
      expect(block, `no ${key} block in the Portal mirror`).toBeTruthy();
      expect(block).toContain(def.description);
      expect(block).toContain(`defaultNoSkills: ${def.defaultNoSkills}`);
      const mirrored = [...(block!.match(/capabilities: \[([^\]]*)\]/)?.[1] ?? "")
        .matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(mirrored, `${key} capabilities drifted`).toEqual(def.capabilities ?? []);
    }
  });

  it("requires knowledge discovery before clarification without coupling the type to retrieval tools", () => {
    const prompt = AGENT_TYPES.knowledge_qa.defaultPrompt;
    expect(prompt).toContain("complete at least one bounded knowledge-discovery step");
    expect(prompt).toContain("before asking the user a clarifying question");
    expect(prompt).toContain("multiple evidence-backed interpretations");
    expect(prompt).not.toContain("knowledge_search");
    expect(prompt).not.toMatch(/full[- ]text|FTS|BM25/i);
  });

  it("normalizeAgentType defaults unknown/absent to custom", () => {
    expect(normalizeAgentType("sre")).toBe("sre");
    expect(() => normalizeAgentType("coordinator")).toThrow("retired");
    expect(() => requireAgentType("coordinator")).toThrow("retired");
    expect(normalizeAgentType("knowledge_qa")).toBe("knowledge_qa");
    expect(normalizeAgentType("product_support")).toBe("product_support");
    expect(normalizeAgentType("coding")).toBe("coding");
    expect(normalizeAgentType("custom")).toBe("custom");
    expect(normalizeAgentType(undefined)).toBe("custom");
    expect(normalizeAgentType("bogus")).toBe("custom");
  });

  it("requireAgentType accepts product_support at the fail-closed harness boundary", () => {
    expect(requireAgentType("product_support")).toBe("product_support");
    expect(() => requireAgentType("future_type")).toThrow("Invalid or missing agent_type");
  });

  it("requireAgentType accepts every registered type — it is a hand-written second enumeration", () => {
    // requireAgentType() compares against literals, so widening the AgentType
    // union does NOT make TypeScript flag a forgotten entry. It THROWS rather
    // than degrading, and it is on the path of every session build, so a
    // forgotten type is not a weaker agent — it is an agent that cannot start.
    // Driving this from the registry is what makes the omission visible.
    for (const key of Object.keys(AGENT_TYPES)) {
      expect(() => requireAgentType(key), `requireAgentType rejects the registered type ${key}`).not.toThrow();
      expect(requireAgentType(key)).toBe(key);
    }
    expect(requireAgentType("coding")).toBe("coding");
  });

  it("normalizeAgentType accepts every registered type — a missing case silently downgrades to custom", () => {
    for (const key of Object.keys(AGENT_TYPES)) {
      expect(normalizeAgentType(key), `normalizeAgentType downgrades the registered type ${key}`).toBe(key);
    }
  });

  it("effectiveCapabilityKeys: built-in types override, custom uses own selection", () => {
    expect(effectiveCapabilityKeys("sre", null)).toEqual(AGENT_TYPES.sre.capabilities);
    expect(effectiveCapabilityKeys("knowledge_qa", ["run_commands"])).toEqual(AGENT_TYPES.knowledge_qa.capabilities);
    expect(effectiveCapabilityKeys("product_support", ["run_commands"])).toEqual(["read_files"]);
    expect(effectiveCapabilityKeys("custom", ["read_files"])).toEqual(["read_files"]);
    expect(effectiveCapabilityKeys("custom", null)).toBeNull();
  });

  it("keeps the compatibility text helper while layering authored specialization", () => {
    expect(effectiveAgentPrompt("knowledge_qa", "maintainer truth")).toBe("maintainer truth");
    expect(effectiveAgentPrompt("knowledge_qa", null)).toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(effectiveAgentPrompt("knowledge_qa", "Prefer concise Chinese answers.")).toBe("Prefer concise Chinese answers.");
    expect(effectiveAgentPrompt("knowledge_qa", null)).toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(effectiveAgentPrompt("custom", "custom truth")).toBe("custom truth");
    expect(effectiveAgentPrompt("custom", "")).toBeUndefined();

    expect(resolveAgentPromptLayers("knowledge_qa", "maintainer truth")).toEqual({
      typeContract: AGENT_TYPES.knowledge_qa.defaultPrompt,
      addendum: "maintainer truth",
    });
    expect(resolveAgentPromptLayers("product_support", "Managed business contract")).toEqual({
      typeContract: PRODUCT_SUPPORT_DEFAULT_PROMPT,
      addendum: "Managed business contract",
    });
    expect(resolveAgentPromptLayers("product_support", "")).toEqual({
      typeContract: PRODUCT_SUPPORT_DEFAULT_PROMPT,
      addendum: undefined,
    });
    expect(resolveAgentPromptLayers("custom", "custom truth")).toEqual({ addendum: "custom truth" });
  });

  it("upgrades only exact materialized Knowledge QA defaults", () => {
    expect(effectiveAgentPrompt("knowledge_qa", LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT))
      .toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(effectiveAgentPrompt("knowledge_qa", PREVIOUS_KNOWLEDGE_QA_DEFAULT_PROMPT))
      .toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(effectiveAgentPrompt("knowledge_qa", COMPLETE_CATALOG_KNOWLEDGE_QA_DEFAULT_PROMPT))
      .toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(effectiveAgentPrompt("knowledge_qa", PRE_DISCOVERY_KNOWLEDGE_QA_DEFAULT_PROMPT))
      .toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(resolveAgentPromptLayers("knowledge_qa", LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT)).toEqual({
      typeContract: AGENT_TYPES.knowledge_qa.defaultPrompt,
      addendum: undefined,
    });
    expect(effectiveAgentPrompt("knowledge_qa", `${LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT} Edited`))
      .toBe(`${LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT} Edited`);
  });

  it("the coding contract names the virtual paths and the manifest, not the flat-tree layout", () => {
    // The flat trees (<repo>@<view> directories, .revision.json) are gone from
    // the code volume; a contract that still named them would send the agent
    // to a file and directories that do not exist.
    expect(CODING_DEFAULT_PROMPT).toContain(".siclaw/repos/<repo>@<sha>/<path>");
    expect(CODING_DEFAULT_PROMPT).toContain("git_query");
    expect(CODING_DEFAULT_PROMPT).toContain(".siclaw/repos/.gitrepos.json");
    expect(CODING_DEFAULT_PROMPT).toContain('"Git history"');
    expect(CODING_DEFAULT_PROMPT).not.toContain(".revision.json");
    expect(CODING_DEFAULT_PROMPT).not.toContain("repository-and-view");
  });

  it("recognises the flat-tree coding default as materialized, not as an addendum", () => {
    // A row persisted while that text was the default must not be re-injected
    // on top of the new contract: it would reintroduce .revision.json.
    expect(resolveAgentPromptLayers("coding", FLAT_TREE_CODING_DEFAULT_PROMPT)).toEqual({
      typeContract: CODING_DEFAULT_PROMPT,
      addendum: undefined,
    });
    expect(resolveAgentPromptLayers("coding", `  ${CODING_DEFAULT_PROMPT}  `)).toEqual({
      typeContract: CODING_DEFAULT_PROMPT,
      addendum: undefined,
    });
    expect(effectiveAgentPrompt("coding", FLAT_TREE_CODING_DEFAULT_PROMPT)).toBe(CODING_DEFAULT_PROMPT);
    // Only the EXACT old text: an edited copy is the operator's and is kept.
    expect(effectiveAgentPrompt("coding", `${FLAT_TREE_CODING_DEFAULT_PROMPT} Edited`))
      .toBe(`${FLAT_TREE_CODING_DEFAULT_PROMPT} Edited`);
  });
});


describe("Ticket Agent instance contract", () => {
  it("requires explicit host capabilities and preserves the tenant business prompt", () => {
    expect(requireAgentType("ticket")).toBe("ticket");
    expect(normalizeAgentType("ticket")).toBe("ticket");
    expect(() => effectiveCapabilityKeys("ticket", null)).toThrow("explicit tool capabilities");
    expect(() => effectiveCapabilityKeys("ticket", [])).toThrow("explicit tool capabilities");
    expect(effectiveCapabilityKeys("ticket", ["read_files"])).toEqual(["read_files"]);
    const layers = resolveAgentPromptLayers("ticket", "Review supplied handling records.");
    expect(layers.addendum).toBe("Review supplied handling records.");
    expect(layers.typeContract).toContain("configured result tool");
    expect(resolveAgentPromptLayers("ticket", "").typeContract).toBe(layers.typeContract);
  });
});
