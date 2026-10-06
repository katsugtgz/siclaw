import { loadConfig } from "./config.js";
import { GatewayClient } from "../agentbox/gateway-client.js";
import { parseCronExpression, getAverageIntervalMs } from "../cron/cron-matcher.js";
import { CRON_LIMITS } from "../cron/cron-limits.js";

export interface ManageScheduleParams {
  action: "create" | "update" | "delete" | "pause" | "resume" | "rename" | "list";
  id?: string;
  name?: string;
  newName?: string;
  description?: string;
  schedule?: string;
  status?: "active" | "paused";
}

/** Shared product operation; Runtime owns task authorization and persistence. */
export async function manageSchedule(params: ManageScheduleParams, sessionId?: string) {
  const cfg = loadConfig();
  const gatewayUrl = cfg.server.gatewayUrl || `http://localhost:${cfg.server.port}`;
  // Thread current chat sessionId so the Gateway can resolve the task
  // owner (userId) via sessionRegistry. Without this, task rows land
  // with empty created_by and downstream cron-task notifications
  // silently drop at Upstream's TaskNotify (empty-userID guard).
  const client = new GatewayClient({ gatewayUrl, sessionId });

  const fail = (msg: string) => ({
    content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
    details: { error: true },
  });
  // Emit the full shape expected by portal-web's ScheduleCard /
  // SchedulePanel so the UI can render a card (with View button + deep
  // link) instead of the raw JSON summary.
  const ok = (summary: string, extra: {
    action?: string;
    id?: string;
    name?: string;
    newName?: string;
    schedule?: { name: string; description?: string; schedule: string; status: string };
  } = {}) => ({
    content: [{ type: "text" as const, text: JSON.stringify({ ...extra, summary }) }],
    details: {},
  });

  // Resolve an id either from params.id or by looking up by name via list.
  // Returns schedule + status when a hit row is found (both paths already
  // run a full list call, so surfacing those fields is free) so the
  // caller — notably pause/resume — can echo the current cron in the
  // tool result instead of emitting an empty-string placeholder.
  const resolveId = async (): Promise<
    { id: string; name: string; schedule?: string; status?: string } | null
  > => {
    if (params.id) {
      // We still need the name for the summary message — list once to find it.
      try {
        const list = await client.listAgentTasks();
        const hit = list.find((t) => t.id === params.id);
        if (hit) return { id: hit.id, name: hit.name, schedule: hit.schedule, status: hit.status };
        return { id: params.id, name: params.id };
      } catch { return { id: params.id, name: params.id }; }
    }
    if (!params.name) return null;
    const list = await client.listAgentTasks();
    const match = list.find((t) => t.name === params.name);
    return match
      ? { id: match.id, name: match.name, schedule: match.schedule, status: match.status }
      : null;
  };

  const validateSchedule = (schedule: string) => {
    parseCronExpression(schedule);
    const { avg, min } = getAverageIntervalMs(schedule, CRON_LIMITS.INTERVAL_SAMPLE_COUNT);
    const limitMin = Math.round(CRON_LIMITS.MIN_INTERVAL_MS / 60_000);
    if (avg < CRON_LIMITS.MIN_INTERVAL_MS) {
      throw new Error(`Schedule interval too short: minimum ${limitMin} minutes between executions`);
    }
    if (min < CRON_LIMITS.ABSOLUTE_MIN_GAP_MS) {
      const floorMin = Math.round(CRON_LIMITS.ABSOLUTE_MIN_GAP_MS / 60_000);
      throw new Error(`Schedule has burst firing: minimum gap between executions must be at least ${floorMin} minutes (average interval must be at least ${limitMin} minutes)`);
    }
  };

  try {
    if (params.action === "list") {
      const tasks = await client.listAgentTasks();
      if (tasks.length === 0) {
        return { content: [{ type: "text" as const, text: "No scheduled tasks currently." }], details: {} };
      }
      const lines = tasks.map((t, i) => {
        const status = t.status === "active" ? "🟢 Running" : "⏸️ Paused";
        return `${i + 1}. **${t.name}** — ${status}\n   Cron: \`${t.schedule}\`${t.description ? `\n   Description: ${t.description}` : ""}${t.lastResult ? `\n   Last result: ${t.lastResult}` : ""}`;
      });
      return {
        content: [{ type: "text" as const, text: `Total ${tasks.length} scheduled task(s):\n\n${lines.join("\n\n")}` }],
        details: {},
      };
    }

    if (params.action === "create") {
      if (!params.name?.trim()) return fail("Schedule name is required.");
      if (!params.schedule?.trim()) return fail("Cron schedule expression is required.");
      validateSchedule(params.schedule.trim());
      const status = params.status ?? "active";
      const name = params.name.trim();
      const schedule = params.schedule.trim();
      const created = await client.createAgentTask({
        name,
        schedule,
        prompt: params.description?.trim() || name,
        description: params.description?.trim(),
        status,
      });
      return ok(
        `Created scheduled task "${name}" (${schedule}).`,
        {
          action: "create",
          id: created?.id,
          name,
          schedule: {
            name,
            description: params.description?.trim(),
            schedule,
            status,
          },
        },
      );
    }

    if (params.action === "update") {
      const target = await resolveId();
      if (!target) return fail("Schedule ID or name is required for update.");
      if (params.schedule?.trim()) validateSchedule(params.schedule.trim());
      await client.updateAgentTask(target.id, {
        name: params.name?.trim(),
        schedule: params.schedule?.trim(),
        prompt: params.description?.trim(),
        description: params.description?.trim(),
        status: params.status,
      });
      const finalName = params.name?.trim() || target.name;
      return ok(`Updated scheduled task "${target.name}".`, {
        action: "update",
        id: target.id,
        name: finalName,
        schedule: params.schedule?.trim()
          ? {
              name: finalName,
              description: params.description?.trim(),
              schedule: params.schedule.trim(),
              status: params.status ?? "active",
            }
          : undefined,
      });
    }

    if (params.action === "delete") {
      const target = await resolveId();
      if (!target) return fail("Schedule ID or name is required for delete.");
      await client.deleteAgentTask(target.id);
      return ok(`Deleted scheduled task "${target.name}".`, {
        action: "delete",
        id: target.id,
        name: target.name,
      });
    }

    if (params.action === "pause" || params.action === "resume") {
      const target = await resolveId();
      if (!target) return fail(`Schedule ID or name is required for ${params.action}.`);
      const newStatus = params.action === "pause" ? "paused" : "active";
      await client.updateAgentTask(target.id, { status: newStatus });
      return ok(
        `${params.action === "pause" ? "Paused" : "Resumed"} scheduled task "${target.name}".`,
        {
          action: params.action,
          id: target.id,
          name: target.name,
          // Emit schedule object only when resolveId surfaced the current
          // cron; otherwise follow the update-branch pattern and omit it
          // so ScheduleCard doesn't render an empty cron field.
          schedule: target.schedule
            ? { name: target.name, schedule: target.schedule, status: newStatus }
            : undefined,
        },
      );
    }

    if (params.action === "rename") {
      const target = await resolveId();
      if (!target) return fail("Schedule ID or current name is required for rename.");
      if (!params.newName?.trim()) return fail("New name is required for rename.");
      await client.updateAgentTask(target.id, { name: params.newName.trim() });
      return ok(
        `Renamed scheduled task "${target.name}" → "${params.newName.trim()}".`,
        {
          action: "rename",
          id: target.id,
          name: target.name,
          newName: params.newName.trim(),
        },
      );
    }

    return fail(`Unknown action: ${params.action}`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
