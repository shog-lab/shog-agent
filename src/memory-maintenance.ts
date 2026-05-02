/**
 * memory-maintenance — ShogAgent Maintenance Daemon
 *
 * Runs as a PM2-managed long-lived process.
 * Responsibilities (per-conversation only, compaction trigger):
 *   B: Analyze compaction summary → formal wiki entry
 *   D: Mark new wiki files for FTS5 index update
 *   F: L2 directly writes skill if repeated pattern found
 *
 * Trigger mechanism:
 * - Pi emits session_compact → memory extension writes to IPC:
 *   /workspace/ipc/{group}/maintenance/pending/{id}.json
 * - For L3: sh script writes to shared IPC after L3 ends
 * - Daemon watches these files via fs.watch / polling
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { initDatabase, getAllRegisteredGroups } from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';

// ── Config ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000; // Poll IPC dir every 30s
const MAX_CONCURRENT = 2; // Max concurrent L2 spawns across all groups

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingMaintenance {
  id: string;
  group: string;
  type: 'compaction';
  sessionId?: string;
  timestamp: string;
  payload?: {
    summaryFile?: string;
    messageCount?: number;
    estimatedTokens?: number;
  };
}

interface MaintenanceResult {
  id: string;
  group: string;
  status: 'success' | 'partial' | 'failed';
  actions: string[]; // human-readable actions taken
  errors: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string, meta?: Record<string, unknown>) {
  logger.info({ service: 'memory-maintenance', ...meta }, msg);
}

function error(msg: string, meta?: Record<string, unknown>) {
  logger.error({ service: 'memory-maintenance', ...meta }, msg);
}

async function spawnL2(
  group: string,
  task: string,
  timeout = 120,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const repoPath = path.join(process.cwd(), 'groups', group);
    const piBin = '/Users/maoxiongyu/.nvm/versions/node/v24.14.0/bin/pi';

    const proc = spawn(
      piBin,
      [
        '--model',
        process.env.MODEL ?? 'MiniMax-M2.7',
        '-p',
        '--no-skills',
        '--append-system-prompt',
        `You are a maintenance sub-agent for group ${group}. Execute the following task and report results as plain text.\n\nTask: ${task}`,
        task,
      ],
      {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MODEL: process.env.MODEL ?? 'minimax-cn/MiniMax-M2.7',
        },
      },
    );

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`L2 timed out after ${timeout}s`));
    }, timeout * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || stdout || `L2 exited with code ${code}`));
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ── Maintenance Tasks ────────────────────────────────────────────────────────

async function handleCompaction(
  pending: PendingMaintenance,
): Promise<MaintenanceResult> {
  const { group, payload } = pending;
  const actions: string[] = [];
  const errors: string[] = [];

  if (!payload?.summaryFile) {
    return {
      id: pending.id,
      group,
      status: 'failed',
      actions: [],
      errors: ['No summaryFile in payload'],
    };
  }

  // B+D: L2 analyzes summary → wiki entry + FTS5 marker
  try {
    // L2 analyzes the summary and writes a formal wiki entry
    const l2Result = await spawnL2(
      group,
      `Read the compaction summary at ${payload.summaryFile}.
Analyze its content and write a formal wiki entry to /workspace/group/wiki/.
File name format: YYYY-MM-DD-{topic-slug}.md
Frontmatter required: date, type (note|decision|fact), tags, summary.
If the summary contains不值得写 wiki 的 trivial 内容，just write "SKIP" as first line.
Also after writing the wiki file，write the path to /workspace/group/wiki/.index-queue so memory extension can update FTS5 index.
Write result as: WIKIPATH:<path> or SKIP`,
      120,
    );

    if (l2Result.startsWith('WIKIPATH:')) {
      const wikiPath = l2Result.replace('WIKIPATH:', '').trim();
      actions.push(`B+D: Wiki at ${path.basename(wikiPath)}, FTS5 queued`);
    } else {
      actions.push(`B+D: No wiki entry needed`);
    }
  } catch (e: unknown) {
    errors.push(`B+D failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // F: L2 directly writes skill if repeated pattern found
  try {
    const l2Result = await spawnL2(
      group,
      `Read the compaction summary at ${payload.summaryFile}.
Analyze if the same problem or pattern has appeared multiple times (check /workspace/group/wiki/ for related entries).
If a clear repeated pattern is found，write a new skill file to /workspace/group/skills/{name}/SKILL.md.
If no pattern，write "SKIP".
If skill is written，also append to /workspace/group/wiki/.skill-evolution-log.md:
- skill path
- trigger reason
- timestamp
Write result as: SKILLWRITTEN:<path> or SKIP`,
      180,
    );
    if (l2Result.startsWith('SKILLWRITTEN:')) {
      const skillPath = l2Result.replace('SKILLWRITTEN:', '').trim();
      actions.push(`F: Skill written at ${skillPath}`);
    } else {
      actions.push('F: No skill evolution needed');
    }
  } catch (e: unknown) {
    errors.push(`F failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    id: pending.id,
    group,
    status:
      errors.length === 0
        ? 'success'
        : errors.length < 2
          ? 'partial'
          : 'failed',
    actions,
    errors,
  };
}

// ── IPC Watching ─────────────────────────────────────────────────────────────

function watchGroupIpc(
  group: { folder: string; name: string },
  onPending: (pending: PendingMaintenance) => void,
) {
  const ipcDir = resolveGroupIpcPath(group.folder);
  const pendingDir = path.join(ipcDir, 'maintenance', 'pending');
  const doneDir = path.join(ipcDir, 'maintenance', 'done');

  // Ensure dirs exist
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.mkdirSync(doneDir, { recursive: true });

  // Poll instead of fs.watch (more reliable across docker bind-mounts)
  const interval = setInterval(() => {
    try {
      const files = fs
        .readdirSync(pendingDir)
        .filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(pendingDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const pending: PendingMaintenance = JSON.parse(content);

          // Move to done immediately to avoid reprocessing
          const donePath = path.join(doneDir, file);
          fs.renameSync(filePath, donePath);

          onPending(pending);
        } catch (e: unknown) {
          error(
            `Failed to process pending file ${file}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }, POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}

// ── Result Logging ─────────────────────────────────────────────────────────────

function writeResult(result: MaintenanceResult) {
  const ipcDir = resolveGroupIpcPath(result.group);
  const resultsDir = path.join(ipcDir, 'maintenance', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const resultFile = path.join(resultsDir, `${result.id}.json`);
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  log(`Maintenance result: ${result.group} - ${result.status}`, {
    actions: result.actions,
    errors: result.errors,
  });
}

// ── Pending Queue ─────────────────────────────────────────────────────────────

const pendingQueue: PendingMaintenance[] = [];
let activeCount = 0;

async function processQueue() {
  if (activeCount >= MAX_CONCURRENT) return;

  while (pendingQueue.length > 0 && activeCount < MAX_CONCURRENT) {
    const pending = pendingQueue.shift()!;
    activeCount++;

    handleCompaction(pending)
      .then(writeResult)
      .catch((e: unknown) => {
        error(
          `Maintenance task failed: ${e instanceof Error ? e.message : String(e)}`,
          {
            pendingId: pending.id,
            group: pending.group,
          },
        );
        writeResult({
          id: pending.id,
          group: pending.group,
          status: 'failed',
          actions: [],
          errors: [e instanceof Error ? e.message : String(e)],
        });
      })
      .finally(() => {
        activeCount--;
        processQueue();
      });
  }
}

// ── Entry Point ───────────────────────────────────────────────────────────────

async function main() {
  log('memory-maintenance daemon starting');

  // Initialize database before using it
  initDatabase();

  const groupsRecord = getAllRegisteredGroups();
  const groups = Object.entries(groupsRecord).map(([jid, g]) => ({
    jid,
    ...g,
  }));
  if (groups.length === 0) {
    error('No groups registered in DB');
    process.exit(1);
  }

  // Watch IPC for each group
  for (const group of groups) {
    watchGroupIpc(group, (pending) => {
      log('Pending maintenance received', {
        group: pending.group,
        type: pending.type,
      });
      pendingQueue.push(pending);
      processQueue();
    });
    log('Watching IPC for group', { group: group.folder });
  }

  log('memory-maintenance daemon running');

  // Keep alive
  process.on('SIGTERM', () => {
    log('Received SIGTERM, shutting down');
    process.exit(0);
  });
}

main().catch((e) => {
  error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
