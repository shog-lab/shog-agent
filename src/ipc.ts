import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendImage: (jid: string, imageUrl: string, caption?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  createInternalAgent?: (folder: string, name: string, persona: string) => void;
  runDelegatedAgent?: (
    agentFolder: string,
    prompt: string,
  ) => Promise<{
    status: 'success' | 'error';
    result: string | null;
    error?: string;
  }>;
  sendPromptToGroup?: (groupJid: string, prompt: string) => boolean;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (
                (data.type === 'message' || data.type === 'image') &&
                data.chatJid
              ) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (data.type === 'image' && data.imageUrl) {
                    await deps.sendImage(
                      data.chatJid,
                      data.imageUrl,
                      data.caption,
                    );
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC image sent',
                    );
                  } else if (data.type === 'message' && data.text) {
                    await deps.sendMessage(data.chatJid, data.text);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC message sent',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For create_agent
    persona?: string;
    // For delegate_task
    requestId?: string;
    agent?: string;
    // For self_improve
    signals?: string;
    context?: string;
    // For agent_message
    from?: string;
    to?: string;
    messageType?: string;
    subject?: string;
    content?: string;
    reply_to?: string;
    // For mailbox_status_update
    messageId?: string;
    status?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        // Convert delay to once: delay is syntactic sugar for "once after N ms"
        let scheduleType = data.schedule_type as
          | 'cron'
          | 'interval'
          | 'once'
          | 'delay';
        let scheduleValue = data.schedule_value as string;
        if (scheduleType === 'delay') {
          const ms = parseInt(scheduleValue, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue }, 'Invalid delay');
            break;
          }
          scheduleType = 'once';
          scheduleValue = new Date(Date.now() + ms).toISOString();
        }

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType as 'cron' | 'interval' | 'once',
          schedule_value: scheduleValue,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'create_agent':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized create_agent attempt blocked',
        );
        break;
      }
      if (
        data.folder &&
        data.name &&
        data.persona &&
        deps.createInternalAgent
      ) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { folder: data.folder },
            'Invalid create_agent request - unsafe folder name',
          );
          break;
        }
        deps.createInternalAgent(data.folder, data.name, data.persona);
        logger.info(
          { folder: data.folder, name: data.name },
          'Internal agent created via IPC',
        );
      }
      break;

    case 'delegate_task':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized delegate_task attempt blocked',
        );
        break;
      }
      if (
        data.requestId &&
        data.agent &&
        data.prompt &&
        deps.runDelegatedAgent
      ) {
        const responseDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'delegates',
        );
        fs.mkdirSync(responseDir, { recursive: true });
        const responseFile = path.join(
          responseDir,
          `${data.requestId}.response.json`,
        );

        // Run target agent asynchronously — write response when done
        deps
          .runDelegatedAgent(data.agent, data.prompt)
          .then((result) => {
            const tempFile = `${responseFile}.tmp`;
            fs.writeFileSync(tempFile, JSON.stringify(result));
            fs.renameSync(tempFile, responseFile);
            logger.info(
              {
                requestId: data.requestId,
                agent: data.agent,
                status: result.status,
              },
              'Delegate task completed',
            );
          })
          .catch((err) => {
            const tempFile = `${responseFile}.tmp`;
            fs.writeFileSync(
              tempFile,
              JSON.stringify({
                status: 'error',
                result: null,
                error: String(err),
              }),
            );
            fs.renameSync(tempFile, responseFile);
            logger.error(
              { requestId: data.requestId, agent: data.agent, err },
              'Delegate task failed',
            );
          });
      }
      break;

    case 'mailbox_status_update': {
      if (!data.messageId || !data.status) {
        logger.warn(
          { sourceGroup, data },
          'mailbox_status_update: missing required fields',
        );
        break;
      }

      const inboxDir = path.join(
        process.cwd(),
        'groups',
        sourceGroup,
        'raw',
        'mailbox',
        'inbox',
      );
      const outboxDir = path.join(
        process.cwd(),
        'groups',
        sourceGroup,
        'raw',
        'mailbox',
        'outbox',
      );
      const candidates = [
        path.join(inboxDir, `${data.messageId}.md`),
        path.join(outboxDir, `${data.messageId}.md`),
      ];
      const targetFile = candidates.find((file) => fs.existsSync(file));
      if (!targetFile) {
        logger.warn(
          { sourceGroup, messageId: data.messageId },
          'mailbox_status_update: message file not found',
        );
        break;
      }

      const allowedStatuses = new Set(['pending', 'read', 'replied', 'closed']);
      if (!allowedStatuses.has(data.status)) {
        logger.warn(
          { sourceGroup, status: data.status },
          'mailbox_status_update: invalid status',
        );
        break;
      }

      const original = fs.readFileSync(targetFile, 'utf8');
      const updated = original.replace(
        /\nstatus: .*\n/,
        `\nstatus: ${data.status}\n`,
      );
      if (updated === original) {
        logger.warn(
          { sourceGroup, messageId: data.messageId },
          'mailbox_status_update: status field not found',
        );
        break;
      }
      fs.writeFileSync(targetFile, updated);
      logger.info(
        { sourceGroup, messageId: data.messageId, status: data.status },
        'Mailbox status updated',
      );
      break;
    }

    case 'agent_message': {
      if (!data.to || !data.content) {
        logger.warn(
          { sourceGroup, data },
          'agent_message: missing required fields',
        );
        break;
      }

      const groups = deps.registeredGroups();
      const targetEntry = Object.entries(groups).find(
        ([, g]) => g.folder === data.to,
      );
      if (!targetEntry) {
        logger.warn(
          { sourceGroup, target: data.to },
          'agent_message: target group not found',
        );
        break;
      }

      const senderGroupDir = path.join(process.cwd(), 'groups', sourceGroup);
      const targetGroupDir = path.join(process.cwd(), 'groups', data.to);
      const senderOutbox = path.join(
        senderGroupDir,
        'raw',
        'mailbox',
        'outbox',
      );
      const targetInbox = path.join(targetGroupDir, 'raw', 'mailbox', 'inbox');
      fs.mkdirSync(senderOutbox, { recursive: true });
      fs.mkdirSync(targetInbox, { recursive: true });

      const createdAt = new Date().toISOString();
      const id = `msg-${createdAt.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
      const messageType = data.messageType || 'message';
      const from = data.from || sourceGroup;
      const status = messageType === 'response' ? 'replied' : 'pending';
      const content = `---\nid: ${id}\nfrom: ${from}\nto: ${data.to}\ntype: ${messageType}\nstatus: ${status}\ncreated_at: ${createdAt}\nreply_to: ${data.reply_to || ''}\nsubject: ${data.subject || ''}\n---\n\n${data.content}\n`;
      const filename = `${id}.md`;
      fs.writeFileSync(path.join(senderOutbox, filename), content);
      fs.writeFileSync(path.join(targetInbox, filename), content);

      const targetJid = targetEntry[0];
      const prompt =
        '你收到一封新邮件。请读取 raw/mailbox/inbox 中 pending 的消息并处理。';
      const sent = deps.sendPromptToGroup?.(targetJid, prompt);
      if (!sent) {
        const taskId = `task-mailbox-${id}`;
        createTask({
          id: taskId,
          group_folder: data.to,
          chat_jid: targetJid,
          prompt,
          script: null,
          schedule_type: 'once',
          schedule_value: new Date().toISOString(),
          context_mode: 'group',
          next_run: new Date().toISOString(),
          status: 'active',
          created_at: new Date().toISOString(),
        });
        deps.onTasksChanged();
        logger.info(
          { sourceGroup, target: data.to, id, taskId },
          'agent_message delivered and mailbox handling task scheduled',
        );
      } else {
        logger.info(
          { sourceGroup, target: data.to, id },
          'agent_message delivered and prompt sent',
        );
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
