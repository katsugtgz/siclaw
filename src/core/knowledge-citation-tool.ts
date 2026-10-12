import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createKnowledgeCitationService, KNOWLEDGE_CITATION_DESCRIPTOR } from "./knowledge-citation-service.js";
export * from "./knowledge-citation-service.js";

/** Pi adapter; validation and read provenance remain engine-independent. */
export function createKnowledgeCitationSupport(opts: Parameters<typeof createKnowledgeCitationService>[0]): {
  captureMount: ReturnType<typeof createKnowledgeCitationService>["captureMount"];
  noteRead: ReturnType<typeof createKnowledgeCitationService>["noteRead"];
  tool: ToolDefinition;
} {
  const service = createKnowledgeCitationService(opts);
  const tool: ToolDefinition = {
    name: "knowledge_cite", label: "Cite Knowledge Sources",
    description: KNOWLEDGE_CITATION_DESCRIPTOR.description,
    parameters: KNOWLEDGE_CITATION_DESCRIPTOR.inputSchema,
    async execute(_id, params) { return service.register(params); },
  };
  return { captureMount: service.captureMount, noteRead: service.noteRead, tool };
}
