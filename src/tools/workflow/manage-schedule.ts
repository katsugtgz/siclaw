import type { ToolEntry } from "../../core/tool-registry.js";
import { CRON_LIMITS } from "../../cron/cron-limits.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { manageSchedule, type ManageScheduleParams } from "../../core/schedule-service.js";
import type { KubeconfigRef } from "../../core/types.js";


export function createManageScheduleTool(
  kubeconfigRef?: KubeconfigRef,
  sessionIdRef?: { current: string },
): ToolDefinition {
  return {
    name: "manage_schedule",
    label: "Manage Schedule",
    description: `Create, update, delete, pause, resume, rename, or list cron schedules for automated task execution.
This tool outputs a structured schedule definition. ALL actions are AUTO-EXECUTED immediately — no user confirmation needed.

NOTE: The "list" action returns schedules scoped to the current agent.
For mutation actions (create, update, delete, pause, resume, rename), the frontend handles agent binding automatically.

CRITICAL — LANGUAGE: The "name" and "description" fields MUST be written in the SAME language the user is speaking.
If the user speaks Korean, write in Korean. If Japanese, write in Japanese. Match the user's language exactly. This directly controls the language of the scheduled task's output.

CRITICAL — TARGET CONTEXT: When creating or updating a schedule, you MUST include the specific target in the description field.
The description must be a self-contained instruction that clearly specifies WHAT to operate on:
- For Kubernetes tasks: include the cluster/environment name and namespace (e.g. "Check abnormal pods in the default namespace of the roce-production cluster")
- For host tasks: include the hostname or IP (e.g. "Check disk usage on host web-server-01")
- For service tasks: include the service name (e.g. "Verify API health of payment-service")
The scheduled task runs autonomously with no user interaction — if the target is ambiguous, the task WILL fail or produce wrong results.

CRITICAL RESPONSE RULES:
- After calling this tool, tell the user the operation is DONE. Use past tense: "Created/Updated/Paused/Resumed/Deleted/Renamed".
- NEVER say "Click", "Confirm", "Update", "Save", or any similar call-to-action.
- NEVER ask the user to do anything to complete the operation — it is already completed automatically.
- Exception: "list" action returns current schedules as text.

Use this tool whenever the user wants to view or change scheduled tasks. Pick the action that matches their intent (see the action enum). One distinction matters: pausing/stopping a schedule is reversible (action "pause") while deleting is permanent (action "delete") — only delete when the user clearly wants it gone for good, not when they just want it stopped or paused.

Parameters:
- action: "create", "update", "delete", "pause", "resume", or "rename"
- id: the schedule ID (UUID) — only when you have the exact ID from a prior "list" result; otherwise omit and use name.
- name: schedule name (used for create, update, or to find a schedule when id is unknown)
- newName: new name for rename action
- description: what the scheduled task should do (natural language — the bot will execute this as a prompt)
- schedule: standard 5-field cron expression (min hour dom month dow)
- status: "active" or "paused"

IMPORTANT: Minimum schedule interval is ${Math.round(CRON_LIMITS.MIN_INTERVAL_MS / 60_000)} minutes. Schedules more frequent than this will be rejected. Do NOT attempt shorter intervals.

Common cron patterns:
- Every hour: 0 * * * *
- Daily at 9am: 0 9 * * *
- Weekdays at 9am: 0 9 * * 1-5
- Weekly Sunday 2am: 0 2 * * 0
- Monthly 1st at midnight: 0 0 1 * *`,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("rename"),
        Type.Literal("list"),
      ], { description: "The action to perform" }),
      id: Type.Optional(
        Type.String({ description: "Schedule ID (UUID). Only use if you obtained the exact ID from a previous list result. Otherwise omit and use name." }),
      ),
      name: Type.Optional(
        Type.String({ description: "Schedule name (for create/update, or to find schedule when id is unknown)" }),
      ),
      newName: Type.Optional(
        Type.String({ description: "New name for rename action" }),
      ),
      description: Type.Optional(
        Type.String({ description: "Self-contained instruction including the specific target (cluster name, hostname, service, etc.) and the action to perform. Must be unambiguous enough to run without user interaction." }),
      ),
      schedule: Type.Optional(
        Type.String({ description: "Cron expression (min hour dom month dow)" }),
      ),
      status: Type.Optional(
        Type.Union([Type.Literal("active"), Type.Literal("paused")], {
          description: "Schedule status",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ManageScheduleParams;

      return manageSchedule(params, sessionIdRef?.current);
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createManageScheduleTool(refs.kubeconfigRef, refs.sessionIdRef),
  modes: ["web", "channel"],
};
