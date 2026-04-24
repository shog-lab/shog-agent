/**
 * Mailbox State Helper Extension
 *
 * Provides a tiny helper for agents to request mailbox message status updates
 * through host-mediated IPC, so message files are updated on the host side.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const IPC_DIR = process.env.IPC_DIR || "/workspace/ipc";
const TASKS_DIR = join(IPC_DIR, "tasks");

function writeIpcFile(data: object): void {
  mkdirSync(TASKS_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = join(TASKS_DIR, filename);
  const tempPath = `${filepath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2));
  renameSync(tempPath, filepath);
}

export default function mailboxStateExtension(pi: ExtensionAPI) {
  pi.tool({
    name: "update_mailbox_status",
    description: "Request a host-mediated mailbox status update for a message file in this group's inbox/outbox.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Mailbox message id, without .md suffix" },
        status: {
          type: "string",
          enum: ["pending", "read", "replied", "closed"],
          description: "New mailbox status",
        },
      },
      required: ["messageId", "status"],
    },
    execute: async ({ messageId, status }: { messageId: string; status: string }) => {
      writeIpcFile({
        type: "mailbox_status_update",
        messageId,
        status,
      });
      return {
        ok: true,
        message: `Mailbox status update requested: ${messageId} -> ${status}`,
      };
    },
  });
}
