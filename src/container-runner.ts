/**
 * Container Runner for ShogAgent
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';

import { readEnvFile } from './env.js';
import {
  validateAdditionalMounts,
  validateCodeRepoMounts,
} from './mount-security.js';
import { RegisteredGroup } from './types.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  images?: Array<{ data: string; mimeType: string }>;
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Mount all other group directories so main group can read conversations
    // and modify AGENTS.md, skills, and memory (evolution manager role).
    try {
      for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === group.folder || entry.name === 'global') continue;
        const otherGroupDir = path.join(GROUPS_DIR, entry.name);
        mounts.push({
          hostPath: otherGroupDir,
          containerPath: `/workspace/agents/${entry.name}`,
          readonly: false,
        });
      }
    } catch {
      /* ignore — best effort */
    }
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group pi agent directory (isolated from other groups)
  // Each group gets their own .pi/agent/ to prevent cross-group session access
  const groupPiDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.pi',
    'agent',
  );
  fs.mkdirSync(groupPiDir, { recursive: true });

  // Built-in skills are loaded from /app/skills/ inside the container image
  // (via additionalSkillPaths). No need to sync them to the group pi directory.
  // Built-in extensions are synced by the container entrypoint script from
  // /tmp/extensions/ to /home/node/.pi/agent/extensions/ on each startup.
  // Agent-created skills go to /workspace/group/skills/ (persistent).
  // Agent-created extensions go to /home/node/.pi/agent/extensions/ (persistent).

  mounts.push({
    hostPath: groupPiDir,
    containerPath: '/home/node/.pi/agent',
    readonly: false, // pi SDK needs writable dir for sessions
  });

  // Mount host auth.json directly (shared across all containers).
  // All containers read/write the same file — token refresh by one is visible to all.
  // Mounted on top of the per-group directory so it takes precedence.
  const hostAuthJson = path.join(os.homedir(), '.pi', 'agent', 'auth.json');
  if (fs.existsSync(hostAuthJson)) {
    // Ensure a placeholder exists so Docker can create the bind-mount target
    // on newly created group directories (avoids "outside of rootfs" errors).
    const placeholderAuth = path.join(groupPiDir, 'auth.json');
    if (!fs.existsSync(placeholderAuth)) {
      fs.writeFileSync(placeholderAuth, '{}');
    }
    mounts.push({
      hostPath: hostAuthJson,
      containerPath: '/home/node/.pi/agent/auth.json',
      readonly: false, // pi SDK needs to write back refreshed OAuth tokens
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  // Code repository mounts (at /workspace/repos/{basename})
  if (group.containerConfig?.codeRepos) {
    const repoMounts = validateCodeRepoMounts(
      group.containerConfig.codeRepos,
      group.name,
      isMain,
      group.containerConfig.codeReposReadOnly ?? false,
    );
    mounts.push(...repoMounts);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  input: ContainerInput,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push('-e', `ANTHROPIC_BASE_URL=http://host.docker.internal:3001`);

  // pi-coding-agent uses ANTHROPIC_API_KEY via the credential proxy.
  // The proxy injects the real key; the container only sees a placeholder.
  args.push('-e', 'ANTHROPIC_API_KEY=placeholder');

  // Pass model configuration from .env to container
  const modelEnv = readEnvFile(['MODEL']);
  if (modelEnv.MODEL) args.push('-e', `MODEL=${modelEnv.MODEL}`);

  // Pass MiniMax API keys from .env to container
  const minimaxEnv = readEnvFile(['MINIMAX_API_KEY', 'MINIMAX_CN_API_KEY']);
  if (minimaxEnv.MINIMAX_API_KEY)
    args.push('-e', `MINIMAX_API_KEY=${minimaxEnv.MINIMAX_API_KEY}`);
  if (minimaxEnv.MINIMAX_CN_API_KEY)
    args.push('-e', `MINIMAX_CN_API_KEY=${minimaxEnv.MINIMAX_CN_API_KEY}`);

  // Pass Jimeng API keys from .env to container
  const jimengEnv = readEnvFile(['JIMENG_ACCESS_KEY', 'JIMENG_SECRET_KEY']);
  if (jimengEnv.JIMENG_ACCESS_KEY)
    args.push('-e', `JIMENG_ACCESS_KEY=${jimengEnv.JIMENG_ACCESS_KEY}`);
  if (jimengEnv.JIMENG_SECRET_KEY)
    args.push('-e', `JIMENG_SECRET_KEY=${jimengEnv.JIMENG_SECRET_KEY}`);

  // Pass WeChat Official Account credentials from .env to container
  const wechatEnv = readEnvFile(['WECHAT_APPID', 'WECHAT_SECRET']);
  if (wechatEnv.WECHAT_APPID)
    args.push('-e', `WECHAT_APPID=${wechatEnv.WECHAT_APPID}`);
  if (wechatEnv.WECHAT_SECRET)
    args.push('-e', `WECHAT_SECRET=${wechatEnv.WECHAT_SECRET}`);

  // Pass container input metadata as env vars for pi RPC mode
  args.push('-e', `CHAT_JID=${input.chatJid}`);
  args.push('-e', `GROUP_FOLDER=${input.groupFolder}`);
  args.push('-e', `IS_MAIN=${input.isMain}`);
  args.push('-e', `ASSISTANT_NAME=${input.assistantName || ''}`);

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `shog-agent-${safeName}-${Date.now()}`;
  const containerArgs = await buildContainerArgs(mounts, containerName, input);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stderr = '';
    let stderrTruncated = false;

    // RPC mode: send initial prompt command via stdin (do NOT close stdin)
    const rpcPromptCmd: Record<string, unknown> = {
      type: 'prompt',
      message: input.prompt,
    };
    if (input.images?.length) {
      rpcPromptCmd.images = input.images.map((img) => ({
        type: 'image',
        data: img.data,
        mimeType: img.mimeType,
      }));
    }
    container.stdin.write(JSON.stringify(rpcPromptCmd) + '\n');

    // Line-buffered JSON parsing for RPC stdout
    let lineBuffer = '';
    let accumulatedText = '';
    let hadStreamingOutput = false;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      lineBuffer += data.toString();

      let newlineIdx: number;
      while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        if (!line) continue;

        try {
          const event = JSON.parse(line);

          // Accumulate text deltas from assistant messages
          if (
            event.type === 'message_update' &&
            event.assistantMessageEvent?.type === 'text_delta'
          ) {
            accumulatedText += event.assistantMessageEvent.delta;
          }

          // agent_end = agent finished processing (prompt or follow-up)
          if (event.type === 'agent_end') {
            hadStreamingOutput = true;
            resetTimeout();

            const text = accumulatedText;
            accumulatedText = '';
            if (onOutput) {
              outputChain = outputChain.then(() =>
                onOutput({
                  status: 'success',
                  result: text || null,
                }),
              );
            }
          }

          // RPC error responses
          if (event.type === 'response' && event.success === false) {
            hadStreamingOutput = true;
            resetTimeout();
            const errorMsg = event.error || 'Unknown RPC error';
            accumulatedText = '';
            if (onOutput) {
              outputChain = outputChain.then(() =>
                onOutput({
                  status: 'error',
                  result: null,
                  error: errorMsg,
                }),
              );
            }
          }
        } catch (err) {
          logger.warn(
            { group: group.name, line, error: err },
            'Failed to parse RPC stdout line',
          );
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful abort has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        if (isVerbose) {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            ``,
          );
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // RPC mode: wait for output chain to settle
      outputChain.then(() => {
        logger.info(
          { group: group.name, duration },
          'Container completed (RPC mode)',
        );
        resolve({
          status: 'success',
          result: null,
        });
      });
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
