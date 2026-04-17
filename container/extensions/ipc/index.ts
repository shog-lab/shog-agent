/**
 * ShogAgent IPC Extension for pi-coding-agent
 *
 * Converted from ipc-tools.ts customTools format to pi extension format.
 * Writes JSON files for the host to pick up via IPC.
 *
 * Context is read from environment variables:
 *   CHAT_JID, GROUP_FOLDER, IS_MAIN
 */

import fs from "fs";
import path from "path";
import { Type, type Static } from "@sinclair/typebox";
import { CronExpressionParser } from "cron-parser";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const IPC_DIR = "/workspace/ipc";
const MESSAGES_DIR = path.join(IPC_DIR, "messages");
const TASKS_DIR = path.join(IPC_DIR, "tasks");

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true as const };
}

// --- Schemas ---

const SendMessageParams = Type.Object({
  text: Type.String({ description: "The message text to send" }),
  sender: Type.Optional(Type.String({ description: 'Your role/identity name (e.g. "Researcher").' })),
});

const SendImageParams = Type.Object({
  url: Type.String({ description: "Image URL to send" }),
  caption: Type.Optional(Type.String({ description: "Optional caption text" })),
});

const ScheduleTaskParams = Type.Object({
  prompt: Type.String({ description: "What the agent should do when the task runs." }),
  schedule_type: Type.Union([Type.Literal("cron"), Type.Literal("interval"), Type.Literal("once"), Type.Literal("delay")], { description: "Schedule type" }),
  schedule_value: Type.String({ description: "Schedule value" }),
  context_mode: Type.Optional(Type.Union([Type.Literal("group"), Type.Literal("isolated")], { description: "Context mode, defaults to group" })),
  target_group_jid: Type.Optional(Type.String({ description: "(Main group only) JID of the target group." })),
});

const TaskIdParams = Type.Object({
  task_id: Type.String({ description: "The task ID" }),
});

const UpdateTaskParams = Type.Object({
  task_id: Type.String({ description: "The task ID to update" }),
  prompt: Type.Optional(Type.String({ description: "New prompt for the task" })),
  schedule_type: Type.Optional(Type.Union([Type.Literal("cron"), Type.Literal("interval"), Type.Literal("once")], { description: "New schedule type" })),
  schedule_value: Type.Optional(Type.String({ description: "New schedule value" })),
});

const EmptyParams = Type.Object({});

const RegisterGroupParams = Type.Object({
  jid: Type.String({ description: "The chat JID" }),
  name: Type.String({ description: "Display name for the group" }),
  folder: Type.String({ description: "Channel-prefixed folder name" }),
  trigger: Type.String({ description: 'Trigger word (e.g., "@Andy")' }),
});

const CreateAgentParams = Type.Object({
  name: Type.String({ description: 'Agent name (e.g., "researcher", "writer")' }),
  persona: Type.String({ description: "Agent persona/instructions for AGENTS.md" }),
});

const DelegateTaskParams = Type.Object({
  agent: Type.String({ description: 'Agent folder name (e.g., "agent-researcher")' }),
  prompt: Type.String({ description: "Task prompt to send to the agent" }),
});

// --- Extension ---

export default function ipcExtension(pi: ExtensionAPI) {
  const chatJid = process.env.CHAT_JID!;
  const groupFolder = process.env.GROUP_FOLDER!;
  const isMain = process.env.IS_MAIN === "true";

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description: "Send a message to the user or group immediately while you're still running. Note: your final text response is also sent automatically, so do NOT use this tool to repeat what you'll say in your final response. Use this only for intermediate updates or when sending alongside images/files.",
    parameters: SendMessageParams,
    execute: async (_toolCallId, params: Static<typeof SendMessageParams>) => {
      writeIpcFile(MESSAGES_DIR, {
        type: "message", chatJid, text: params.text, sender: params.sender || undefined,
        groupFolder, timestamp: new Date().toISOString(),
      });
      return ok("Message sent.");
    },
  });

  pi.registerTool({
    name: "send_image",
    label: "Send Image",
    description: "Send an image to the user or group by URL. Use this after generating images with jimeng_generate or any other image tool.",
    parameters: SendImageParams,
    execute: async (_toolCallId, params: Static<typeof SendImageParams>) => {
      writeIpcFile(MESSAGES_DIR, {
        type: "image", chatJid, imageUrl: params.url, caption: params.caption || undefined,
        groupFolder, timestamp: new Date().toISOString(),
      });
      return ok("Image sent.");
    },
  });

  pi.registerTool({
    name: "schedule_task",
    label: "Schedule Task",
    description: `Schedule a recurring or one-time task. Returns the task ID.

CONTEXT MODE: "group" (with chat history) or "isolated" (fresh session).
SCHEDULE FORMAT (local timezone): cron "0 9 * * *", interval "300000", once "2026-02-01T15:30:00", delay "540000" (run once after N ms)`,
    parameters: ScheduleTaskParams,
    execute: async (_toolCallId, params: Static<typeof ScheduleTaskParams>) => {
      if (params.schedule_type === "cron") {
        try { CronExpressionParser.parse(params.schedule_value); } catch {
          return err(`Invalid cron: "${params.schedule_value}".`);
        }
      } else if (params.schedule_type === "interval") {
        const ms = parseInt(params.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) return err(`Invalid interval: "${params.schedule_value}".`);
      } else if (params.schedule_type === "delay") {
        const ms = parseInt(params.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) return err(`Invalid delay: "${params.schedule_value}". Must be positive milliseconds.`);
      } else if (params.schedule_type === "once") {
        if (/[Zz]$/.test(params.schedule_value) || /[+-]\d{2}:\d{2}$/.test(params.schedule_value))
          return err("Timestamp must be local time without timezone suffix.");
        if (isNaN(new Date(params.schedule_value).getTime()))
          return err(`Invalid timestamp: "${params.schedule_value}".`);
      }

      const targetJid = isMain && params.target_group_jid ? params.target_group_jid : chatJid;
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      writeIpcFile(TASKS_DIR, {
        type: "schedule_task", taskId, prompt: params.prompt,
        schedule_type: params.schedule_type, schedule_value: params.schedule_value,
        context_mode: params.context_mode || "group", targetJid,
        createdBy: groupFolder, timestamp: new Date().toISOString(),
      });
      return ok(`Task ${taskId} scheduled: ${params.schedule_type} - ${params.schedule_value}`);
    },
  });

  pi.registerTool({
    name: "list_tasks",
    label: "List Tasks",
    description: "List all scheduled tasks.",
    parameters: EmptyParams,
    execute: async () => {
      const tasksFile = path.join(IPC_DIR, "current_tasks.json");
      try {
        if (!fs.existsSync(tasksFile)) return ok("No scheduled tasks found.");
        const allTasks = JSON.parse(fs.readFileSync(tasksFile, "utf-8"));
        const tasks = isMain ? allTasks : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);
        if (tasks.length === 0) return ok("No scheduled tasks found.");
        const formatted = tasks
          .map((t: { id: string; groupFolder: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] [${t.groupFolder}] ${t.prompt} (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || "N/A"}`)
          .join("\n");
        return ok(`Scheduled tasks:\n${formatted}`);
      } catch (e) {
        return ok(`Error reading tasks: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "pause_task",
    label: "Pause Task",
    description: "Pause a scheduled task.",
    parameters: TaskIdParams,
    execute: async (_toolCallId, params: Static<typeof TaskIdParams>) => {
      writeIpcFile(TASKS_DIR, { type: "pause_task", taskId: params.task_id, groupFolder, isMain, timestamp: new Date().toISOString() });
      return ok(`Task ${params.task_id} pause requested.`);
    },
  });

  pi.registerTool({
    name: "resume_task",
    label: "Resume Task",
    description: "Resume a paused task.",
    parameters: TaskIdParams,
    execute: async (_toolCallId, params: Static<typeof TaskIdParams>) => {
      writeIpcFile(TASKS_DIR, { type: "resume_task", taskId: params.task_id, groupFolder, isMain, timestamp: new Date().toISOString() });
      return ok(`Task ${params.task_id} resume requested.`);
    },
  });

  pi.registerTool({
    name: "cancel_task",
    label: "Cancel Task",
    description: "Cancel and delete a scheduled task.",
    parameters: TaskIdParams,
    execute: async (_toolCallId, params: Static<typeof TaskIdParams>) => {
      writeIpcFile(TASKS_DIR, { type: "cancel_task", taskId: params.task_id, groupFolder, isMain, timestamp: new Date().toISOString() });
      return ok(`Task ${params.task_id} cancellation requested.`);
    },
  });

  pi.registerTool({
    name: "update_task",
    label: "Update Task",
    description: "Update an existing scheduled task. Only provided fields are changed.",
    parameters: UpdateTaskParams,
    execute: async (_toolCallId, params: Static<typeof UpdateTaskParams>) => {
      if (params.schedule_type === "cron" && params.schedule_value) {
        try { CronExpressionParser.parse(params.schedule_value); } catch {
          return err(`Invalid cron: "${params.schedule_value}".`);
        }
      }
      if (params.schedule_type === "interval" && params.schedule_value) {
        const ms = parseInt(params.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) return err(`Invalid interval: "${params.schedule_value}".`);
      }

      const data: Record<string, string | undefined> = {
        type: "update_task", taskId: params.task_id, groupFolder,
        isMain: String(isMain), timestamp: new Date().toISOString(),
      };
      if (params.prompt !== undefined) data.prompt = params.prompt;
      if (params.schedule_type !== undefined) data.schedule_type = params.schedule_type;
      if (params.schedule_value !== undefined) data.schedule_value = params.schedule_value;

      writeIpcFile(TASKS_DIR, data);
      return ok(`Task ${params.task_id} update requested.`);
    },
  });

  pi.registerTool({
    name: "register_group",
    label: "Register Group",
    description: "Register a new chat/group. Main group only.",
    parameters: RegisterGroupParams,
    execute: async (_toolCallId, params: Static<typeof RegisterGroupParams>) => {
      if (!isMain) return err("Only the main group can register new groups.");
      writeIpcFile(TASKS_DIR, {
        type: "register_group", jid: params.jid, name: params.name,
        folder: params.folder, trigger: params.trigger, timestamp: new Date().toISOString(),
      });
      return ok(`Group "${params.name}" registered.`);
    },
  });

  pi.registerTool({
    name: "create_agent",
    label: "Create Agent",
    description: "Create a persistent internal agent with its own persona. Main group only. The agent will be available for delegate_task.",
    parameters: CreateAgentParams,
    execute: async (_toolCallId, params: Static<typeof CreateAgentParams>) => {
      if (!isMain) return err("Only the main group can create agents.");
      const folder = `agent-${params.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
      writeIpcFile(TASKS_DIR, {
        type: "create_agent", name: params.name, folder, persona: params.persona,
        timestamp: new Date().toISOString(),
      });
      return ok(`Agent "${params.name}" created (folder: ${folder}). Use delegate_task to assign work.`);
    },
  });

  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: "Send a task to an internal agent and wait for the result. Main group only. The agent runs in its own container with independent context.",
    parameters: DelegateTaskParams,
    execute: async (_toolCallId, params: Static<typeof DelegateTaskParams>) => {
      if (!isMain) return err("Only the main group can delegate tasks.");
      const requestId = `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const responseFile = path.join(IPC_DIR, "delegates", `${requestId}.response.json`);

      // Write delegation request for host to pick up
      writeIpcFile(TASKS_DIR, {
        type: "delegate_task", requestId, agent: params.agent, prompt: params.prompt,
        timestamp: new Date().toISOString(),
      });

      // Poll for response (host runs the target agent and writes result back)
      const timeoutMs = 300000; // 5 minutes max
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        if (fs.existsSync(responseFile)) {
          try {
            const result = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
            fs.unlinkSync(responseFile);
            if (result.status === "error") return err(`Agent "${params.agent}" error: ${result.error}`);
            return ok(result.result || "Task completed (no output).");
          } catch { /* retry read */ }
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      return err(`Delegate task to "${params.agent}" timed out after ${timeoutMs / 1000}s.`);
    },
  });
}
