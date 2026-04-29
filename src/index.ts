import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
  TRIGGERS_DIR,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  cleanupOldMessages,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  createTask,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  reattachImages,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';

import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Seed AGENTS.md from template if missing
  const agentsMdPath = path.join(groupDir, 'AGENTS.md');
  const templatePath = path.join(
    process.cwd(),
    'container',
    'templates',
    'AGENTS.md',
  );
  if (!fs.existsSync(agentsMdPath) && fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, agentsMdPath);
    logger.info({ folder: group.folder }, 'Seeded AGENTS.md from template');
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = reattachImages(
    getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME),
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present.
  // Channels that handle their own triggering (e.g. DingTalk @mention) skip this.
  if (
    !isMainGroup &&
    group.requiresTrigger !== false &&
    !channel.handlesOwnTrigger
  ) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Collect image attachments from messages
  const images = missedMessages.flatMap((m) => m.images || []);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    images.length ? images : undefined,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  images?: Array<{ data: string; mimeType: string }>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        images: images?.length ? images : undefined,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`ShogAgent running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger =
            !isMainGroup &&
            group.requiresTrigger !== false &&
            !channel?.handlesOwnTrigger;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = reattachImages(
            getMessagesSince(
              chatJid,
              lastAgentTimestamp[chatJid] || '',
              ASSISTANT_NAME,
            ),
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);
          const pipeImages = messagesToSend.flatMap((m) => m.images || []);

          const piped = queue.sendMessage(
            chatJid,
            formatted,
            pipeImages.length ? pipeImages : undefined,
          );
          logger.info(
            { chatJid, piped, count: messagesToSend.length },
            piped
              ? 'Piped messages to active container'
              : 'No active container, enqueueing',
          );
          if (piped) {
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
      // Check for manual trigger files
      checkManualTriggers();
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Manual trigger: scan data/triggers/ for JSON files and enqueue agent runs.
 *
 * Trigger file format (named anything ending in .json):
 *   { "group": "group-haowangjiao", "prompt": "...", "replayHistory": true }
 *
 * - group: folder name of a registered group
 * - prompt: custom prompt to send to the agent (optional if replayHistory is true)
 * - replayHistory: if true, include unprocessed messages from SQLite as context
 */
function checkManualTriggers(): void {
  fs.mkdirSync(TRIGGERS_DIR, { recursive: true });

  let files: string[];
  try {
    files = fs.readdirSync(TRIGGERS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = path.join(TRIGGERS_DIR, file);
    let trigger: { group: string; prompt?: string; replayHistory?: boolean };

    try {
      trigger = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.warn({ file, err }, 'Failed to parse trigger file, removing');
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
      continue;
    }

    // Find registered group by folder name
    const entry = Object.entries(registeredGroups).find(
      ([, g]) => g.folder === trigger.group,
    );
    if (!entry) {
      logger.warn({ group: trigger.group }, 'Manual trigger: group not found');
      continue;
    }

    const [chatJid, group] = entry;
    const channel = findChannel(channels, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'Manual trigger: no channel owns JID');
      continue;
    }

    // Build prompt
    let prompt = trigger.prompt || '';
    if (trigger.replayHistory) {
      const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
      const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
      if (pending.length > 0) {
        const historyPrompt = formatMessages(pending, TIMEZONE);
        prompt = prompt
          ? `${prompt}\n\n以下是未处理的历史消息:\n${historyPrompt}`
          : historyPrompt;
        // Advance cursor
        lastAgentTimestamp[chatJid] = pending[pending.length - 1].timestamp;
        saveState();
      }
    }

    if (!prompt) {
      logger.warn(
        { group: trigger.group },
        'Manual trigger: empty prompt, skipping',
      );
      continue;
    }

    logger.info(
      { group: group.name, prompt: prompt.slice(0, 100) },
      'Manual trigger',
    );

    const triggerId = `trigger-${Date.now()}`;
    queue.enqueueTask(chatJid, triggerId, async () => {
      await channel.setTyping?.(chatJid, true);
      await runAgent(group, prompt, chatJid, async (result) => {
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (text) {
            await channel.sendMessage(chatJid, text);
          }
        }
        if (result.status === 'success') {
          queue.notifyIdle(chatJid);
        }
      });
      await channel.setTyping?.(chatJid, false);
    });
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

const CLEANUP_MAX_AGE_DAYS = 30;

/**
 * Clean up old log files and database messages.
 * Runs on startup and can be called periodically.
 */
function runDataCleanup(): void {
  // 1. Clean old log files from all groups
  try {
    const cutoff = Date.now() - CLEANUP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    let deletedLogs = 0;

    if (fs.existsSync(GROUPS_DIR)) {
      for (const group of fs.readdirSync(GROUPS_DIR)) {
        const logDir = path.join(GROUPS_DIR, group, 'logs');
        if (!fs.existsSync(logDir)) continue;
        for (const file of fs.readdirSync(logDir)) {
          if (!file.endsWith('.log')) continue;
          const filePath = path.join(logDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoff) {
              fs.unlinkSync(filePath);
              deletedLogs++;
            }
          } catch {
            /* ignore individual file errors */
          }
        }
      }
    }

    if (deletedLogs > 0) {
      logger.info(
        { deletedLogs, maxAgeDays: CLEANUP_MAX_AGE_DAYS },
        'Cleaned up old log files',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Log cleanup failed');
  }

  // 3. Clean old database messages
  try {
    const deletedMessages = cleanupOldMessages(CLEANUP_MAX_AGE_DAYS);
    if (deletedMessages > 0) {
      logger.info(
        { deletedMessages, maxAgeDays: CLEANUP_MAX_AGE_DAYS },
        'Cleaned up old database messages',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Database message cleanup failed');
  }
}

const PID_FILE = path.join(process.cwd(), 'data', 'shog-agent.pid');

function acquirePidLock(): void {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (oldPid) {
      try {
        process.kill(oldPid, 0); // check if alive
        logger.error(
          { oldPid },
          'Another ShogAgent instance is already running. Exiting.',
        );
        process.exit(1);
      } catch {
        // Process not running, stale pid file
      }
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function releasePidLock(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
}

async function main(): Promise<void> {
  acquirePidLock();
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');

  // Cleanup old data on startup
  runDataCleanup();

  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    releasePidLock();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
      senderId?: string,
    ) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup, senderId),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendImage: async (jid, imageUrl, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendImage) {
        await channel.sendImage(jid, imageUrl, caption);
      } else {
        // Fallback: send as text link
        await channel.sendMessage(
          jid,
          caption ? `${caption}\n${imageUrl}` : imageUrl,
        );
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    createInternalAgent: (folder, name, persona) => {
      const internalJid = `internal:${folder}`;
      const groupDir = resolveGroupFolderPath(folder);
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(
        path.join(groupDir, 'AGENTS.md'),
        `# ${name}\n\n${persona}\n`,
      );
      registerGroup(internalJid, {
        name,
        folder,
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      });
      logger.info({ folder, name }, 'Internal agent created');
    },
    runDelegatedAgent: async (agentFolder, prompt) => {
      const internalJid = `internal:${agentFolder}`;
      const group = registeredGroups[internalJid];
      if (!group) {
        return {
          status: 'error' as const,
          result: null,
          error: `Agent "${agentFolder}" not found`,
        };
      }

      let resultText: string | null = null;
      let error: string | undefined;

      const output = await runContainerAgent(
        group,
        {
          prompt,
          groupFolder: agentFolder,
          chatJid: internalJid,
          isMain: false,
          assistantName: group.name,
        },
        (proc, containerName) =>
          queue.registerProcess(internalJid, proc, containerName, agentFolder),
        async (result) => {
          if (result.result) {
            resultText =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
          }
          if (result.status === 'error') {
            error = result.error;
          }
        },
      );

      if (output.status === 'error' || error) {
        return {
          status: 'error' as const,
          result: null,
          error: error || output.error,
        };
      }
      return { status: 'success' as const, result: resultText };
    },
    sendPromptToGroup: (groupJid, prompt) => {
      return queue.sendMessage(groupJid, prompt);
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start ShogAgent');
    process.exit(1);
  });
}
