/**
 * ShogAgent Sub-Agent Extension
 *
 * Provides spawn_subagent tool for L1 to spawn L2 sub-agents in repos.
 * Sub-agents have minimal context (no wiki, no group skills, no AGENTS.md).
 */

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SubAgentParams = Type.Object({
  repo: Type.String({ description: "Absolute path to the repository directory. Must be within /workspace/repos/ for security." }),
  prompt: Type.String({ description: "Task instruction for the sub-agent. Be specific about what to do and what to return." }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 300, max: 600)" })),
});

const EXTENSIONS_DIR = "/home/node/.pi/agent/extensions";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true as const };
}

function resolveExtensionPath(name: string): string | null {
  const p = path.join(EXTENSIONS_DIR, name);
  // Try common entry points
  for (const entry of ["dist/index.js", "index.ts", "index.js"]) {
    if (fs.existsSync(path.join(p, entry))) return path.join(p, entry);
  }
  return null;
}

export default function subagentExtension(_pi: ExtensionAPI) {
  _pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Sub-Agent",
    description:
      "Spawn a sub-agent (L2) in a target repository to execute a specific task. " +
      "The sub-agent has minimal context: no wiki access, no group skills, no AGENTS.md. " +
      "Use this for isolated tasks like running tests, reading code, or code review. " +
      "Security: repo path must be within /workspace/repos/.",
    parameters: SubAgentParams,
    async execute(_toolCallId: string, params: Static<typeof SubAgentParams>) {
      // Security: validate repo path
      const normalized = path.normalize(params.repo);
      if (!normalized.startsWith("/workspace/repos/")) {
        return err(`Security: repo must be within /workspace/repos/. Got: ${params.repo}`);
      }
      if (!fs.existsSync(normalized)) {
        return err(`Repo does not exist: ${params.repo}`);
      }

      const timeoutSec = Math.min(params.timeout ?? 300, 600);
      const timeoutMs = timeoutSec * 1000;

      // Build pi arguments — use -p (non-interactive) with prompt as CLI arg.
      // This avoids needing to pipe stdin which is already consumed by L1's RPC stdin.
      const piBin = "/app/node_modules/.bin/pi";
      const args = [
        "-p",                        // non-interactive: read prompt from args, exit when done
        "--no-extensions",           // no group extensions — subagent gets minimal context
        "--model", process.env.MODEL ?? "minimax-cn/MiniMax-M2.7",
      ];

      // Load basic extensions if available (web_search, agent_browser, memory)
      const basicExts = ["web_search", "agent_browser", "memory"];
      for (const ext of basicExts) {
        const extPath = resolveExtensionPath(ext);
        if (extPath) args.push("-e", extPath);
      }

      // System prompt for sub-agent isolation rules
      const systemPrompt = [
        "You are a sub-agent (L2) executing a task in a repository.",
        "Rules:",
        "- Read code, run tests, verify behavior — report findings as plain text",
        "- Do not write code unless explicitly asked to in the task",
        "- Do not access wiki, group skills, AGENTS.md, or any persistent memory",
        "- Do not modify the repo unless the task explicitly requires it",
        "- Return your findings, results, or errors as plain text",
        "",
        `Task: ${params.prompt}`,
      ].join("\n");
      args.push("--append-system-prompt", systemPrompt);

      // Pass the actual task as a positional argument (not via stdin — stdin is already consumed)
      args.push(params.prompt);

      return new Promise((resolve) => {
        let killed = false;
        const proc = spawn(piBin, args, {
          cwd: normalized,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],  // stdin=ignore (prompt is in args)
        });

        const timer = setTimeout(() => {
          killed = true;
          proc.kill("SIGTERM");
          setTimeout(() => proc.kill("SIGKILL"), 5000);
        }, timeoutMs);

        let stdout = "";
        let stderr = "";

        proc.stdout?.on("data", (d) => { stdout += d.toString(); });
        proc.stderr?.on("data", (d) => { stderr += d.toString(); });

        proc.on("close", (code) => {
          clearTimeout(timer);
          if (killed) {
            resolve(err(`Sub-agent timed out after ${timeoutSec}s`));
          } else if (code === 0) {
            // Strip pi's decorative wrapper, keep the meaningful output
            const text = stdout
              .replace(/^\*\*Output:\*\*\n?/s, "")
              .replace(/^.*?---\n/s, "")
              .replace(/^\*\*\(.+\)\*\*\n?/s, "")
              .trim() || "Done.";
            resolve(ok(text));
          } else {
            resolve(err(stderr || stdout || `Sub-agent exited with code ${code}`));
          }
        });

        proc.on("error", (e) => {
          clearTimeout(timer);
          resolve(err(`Failed to spawn sub-agent: ${e.message}`));
        });
      });
    },
  });
}
