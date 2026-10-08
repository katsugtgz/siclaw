import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { previewSkillDraft } from "../../core/skill-preview-service.js";


interface SkillPreviewParams {
  dir: string;
}

export function createSkillPreviewTool(): ToolDefinition {
  return {
    name: "skill_preview",
    label: "Skill Preview",
    description: `Render a skill draft as a structured preview panel with copy buttons.

**Workflow** — when the user asks to create, modify, or improve a skill:
1. First explain what you plan to build or change.
2. Write ALL files to \`.siclaw/user-data/skill-drafts/<name>/\` — SKILL.md AND all scripts. Write every file BEFORE calling skill_preview.
3. Call \`skill_preview\` ONCE with the directory path, after ALL files are written.

**IMPORTANT**:
- Write ALL files first, then call skill_preview ONCE. Do NOT call skill_preview after writing only SKILL.md — wait until scripts are also written.
- skill_preview **deletes the directory** after reading. Do NOT write more files or call skill_preview again — the directory is gone. If you need to redo, write all files from scratch to a new directory.

**SKILL.md format**:
\`\`\`
---
name: <kebab-case-name>
description: >-
  One-line summary. Mention the execution tool if the skill uses scripts.
---
# <Title>
## Purpose    — what problem this solves
## Tool       — execution tool invocation (required for script-based skills)
## Parameters — table of required/optional parameters
## Procedure  — step-by-step actions with concrete commands
## Examples   — concrete tool invocations with realistic parameters
\`\`\`

**Script execution modes**:
| Tool | Runs where | When to use |
|------|-----------|-------------|
| \`local_script\` | AgentBox | kubectl commands from outside the cluster — most common |
| \`node_script\` | K8s node | Needs host tools, /proc, /sys, devices |
| \`pod_script\` | Inside a pod | Diagnostics inside a running container |
| \`node_script\` + \`netns\` | Node + pod network ns | Host tools + pod network view |`,
    parameters: Type.Object({
      dir: Type.String({
        description: "Path to the skill draft directory (e.g. '.siclaw/user-data/skill-drafts/check-pod-oom')",
      }),
    }),
    async execute(_toolCallId, rawParams, signal) {
      return previewSkillDraft((rawParams as SkillPreviewParams).dir, { signal });
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (_refs) => createSkillPreviewTool(),
  modes: ["web", "channel"],
};
