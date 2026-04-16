/**
 * ShogAgent Agent Runner (pi-coding-agent edition)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';
import { getModel } from '@mariozechner/pi-ai';
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@mariozechner/pi-coding-agent';
import { createIpcTools } from './ipc-tools.js';
import { createWebTools } from './web-tools.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  images?: Array<{ data: string; mimeType: string }>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---SHOGCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---SHOGCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

interface IpcMessage {
  text: string;
  images?: Array<{ type: 'image'; data: string; mimeType: string }>;
}

function drainIpcInput(): IpcMessage[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: IpcMessage[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && (data.text || data.images?.length)) {
          const msg: IpcMessage = { text: data.text || '' };
          if (data.images?.length) {
            msg.images = data.images.map((img: { data: string; mimeType: string }) => ({
              type: 'image' as const, data: img.data, mimeType: img.mimeType,
            }));
          }
          messages.push(msg);
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES') {
          // File not yet synced (VirtioFS on macOS Docker) — skip, retry next poll
          continue;
        }
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<IpcMessage | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        // Merge multiple messages into one
        const text = messages.map(m => m.text).filter(Boolean).join('\n');
        const images = messages.flatMap(m => m.images || []);
        resolve({ text, images: images.length ? images : undefined });
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Archive conversation transcript for audit/debugging purposes.
 * Separate from the mem extension — this is a full dump, not selective memory.
 */
function archiveTranscript(messages: Array<{ role: string; content: unknown }>, assistantName?: string): void {
  try {
    const parsed: Array<{ role: string; text: string }> = [];
    for (const msg of messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('')
            : '';
        if (text) parsed.push({ role: msg.role, text });
      }
    }

    if (parsed.length === 0) return;

    const conversationsDir = '/workspace/group/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = `${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
    const filename = `${date}-conversation-${time}.md`;
    const filePath = path.join(conversationsDir, filename);

    const lines: string[] = ['# Conversation', '', `Archived: ${now.toLocaleString()}`, '', '---', ''];
    for (const msg of parsed) {
      const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
      const content = msg.text.length > 2000 ? msg.text.slice(0, 2000) + '...' : msg.text;
      lines.push(`**${sender}**: ${content}`, '');
    }

    fs.writeFileSync(filePath, lines.join('\n'));
    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Create the pi agent session with all tools configured.
 */
async function createSession(containerInput: ContainerInput): Promise<AgentSession> {
  const cwd = '/workspace/group';

  // Auth: use credential proxy via ANTHROPIC_BASE_URL env var
  const authStorage = AuthStorage.create('/home/node/.pi/agent/auth.json');
  if (process.env.ANTHROPIC_API_KEY) {
    authStorage.setRuntimeApiKey('anthropic', process.env.ANTHROPIC_API_KEY);
  }

  const modelRegistry = ModelRegistry.create(authStorage);

  // Resolve model from environment or default
  const modelSpec = process.env.MODEL || 'openai-codex/gpt-5.2-codex';
  const [provider, name] = modelSpec.split('/');
  const model = provider && name ? getModel(provider as any, name as any) : null;
  if (!model) throw new Error(`Model not found: ${modelSpec}. Check ~/.pi/agent/auth.json for valid credentials.`);
  log(`Using model: ${modelSpec}`);

  // Build system prompt
  let systemPrompt = `Your persona and behavioral guidelines are in /workspace/group/AGENTS.md — follow them.

## Wiki — your knowledge system

Your knowledge is stored in an LLM Wiki structure under /workspace/group/:

\`\`\`
/workspace/group/
├── wiki/              ← all knowledge pages, flat (your primary read/write target)
│   └── compaction/    ← auto-saved conversation summaries (don't write here)
├── raw/               ← immutable source materials (read-only reference)
├── schema/            ← wiki rules and quality standards
└── .wiki-index.db     ← search index (managed by system)
\`\`\`

Relevant wiki pages are automatically injected into your context before each query. When a user mentions personal facts, preferences, schedules, or other reusable information (even without explicitly asking you to remember), save it to wiki automatically.

### Writing to wiki

Write Markdown files directly to wiki/:

\`\`\`markdown
---
date: ${new Date().toISOString()}
type: fact
tags: [topic1, topic2]
---

Content here.
\`\`\`

**Type determines how memories are loaded:**
- \`fact\`, \`preference\`, \`decision\` → L1: always injected into every conversation
- \`note\`, \`research\`, \`workflow\` → L2/L3: injected when relevant to the query
- \`compaction\` → auto-saved by system, don't set manually

### Knowledge graph triples

When a memory involves people, schedules, or relationships, add a triples field:

\`\`\`markdown
---
date: ${new Date().toISOString()}
type: fact
tags: [人物]
triples: [["戴莹珏", "下班时间", "18:30"], ["戴莹珏", "角色", "UI设计师"]]
---

戴莹珏每天 18:30 下班。
\`\`\`

### Page interconnection

Use [[page-name]] to link between wiki pages. Linked pages are automatically loaded when the linking page is retrieved. Example:

\`\`\`markdown
This builds on the findings in [[agent-memory]] and relates to [[agent-evolution]].
\`\`\`

### Knowledge writeback

If your response contains a reusable finding — a research conclusion, technical solution, factual discovery, or decision rationale — write it as a wiki page after replying. This turns one-off answers into persistent knowledge that compounds over time. Don't write trivial Q&A; only write when the knowledge has future value.

Your final text response is automatically sent to the user, so don't use send_message to repeat it. But DO use send_message when you need to: acknowledge before starting a long task ("好的，我来处理"), send progress updates mid-task, or send an image/file alongside your text response.

## How you run

You run inside a container that starts when triggered and stops after idle timeout. You are not a persistent service — you cannot work in the background or deliver results at a future time unless you schedule a task with schedule_task. Be honest about this with users.

## Autonomy

Bias toward action. When the task is clear, execute it directly — don't ask for confirmation. Only ask when there is genuine ambiguity about what the user wants, not when you're unsure about implementation details. Figure those out yourself. If you make a mistake, it can be corrected later; hesitation and over-asking waste more time than a wrong attempt.

## Intent declaration

Before calling any tool or executing any command, briefly state what you're about to do and why. One sentence is enough — don't over-explain.

## Task logging

After completing any task (skill execution, web fetch, content generation, question answering, etc.), append a one-line JSON entry to /workspace/group/task-logs.jsonl:

{"task":"<what you did>","skill":"<skill name if used>","timestamp":"<ISO>","result":"success|fail|skip","reason":"<if fail/skip>"}

This log is used by the evolution manager to evaluate agent performance. Always log, even for simple tasks.

## Runtime self-improvement

If a skill doesn't work well during execution (wrong steps, missing info, outdated assumptions), fix it on the spot — update the SKILL.md in /workspace/group/skills/ and continue. Don't wait for someone else to fix it. This is not evolution (periodic review); this is adapting in real time.

## Web access fallback

When web_search or web_fetch fails (network error, JS-only page, blocked), fall back to agent-browser to open the URL directly. Don't give up just because the lightweight tools failed.

## Skills

Your capabilities are extended through skills, which are automatically discovered and loaded from:
- Built-in skills (shared across all groups)
- /workspace/group/skills/ (group-specific, persistent)

You can create new skills to add workflows or abilities to yourself. Use the skill-authoring skill for guidance.

## Extensions

Your tools are extended through extensions, which are automatically discovered and loaded from /home/node/.pi/agent/extensions/. Extensions are TypeScript modules that can register custom tools or hook into agent lifecycle events.

You can create new extensions to add tool capabilities. Use the extension-authoring skill for guidance.

## Capability boundary

Your capabilities are determined by your skills, extensions, and built-in tools. If a user asks for something beyond these existing capabilities, be honest that it's not currently supported and suggest it could be achieved by creating a new skill or extension. Never pretend to have capabilities you don't have.

Built-in skills (/app/skills/) and built-in extensions (memory, jimeng, etc.) are managed by the platform maintainer and overwritten on each container startup. Do not modify them — create new ones instead. If you identify improvements to built-in components, report them to the user rather than editing directly.

## Self-improvement

When you need to improve yourself, choose the right mechanism:
- Change your persona, behavior or style → modify AGENTS.md
- Record knowledge, facts, decisions → write to wiki/
- Add a workflow or process → create a skill
- Add a tool or hook lifecycle events → create an extension`;

  // Load group CLAUDE.md / AGENTS.md
  const agentsMdPath = path.join(cwd, 'AGENTS.md');
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  if (fs.existsSync(agentsMdPath)) {
    systemPrompt += '\n\n' + fs.readFileSync(agentsMdPath, 'utf-8');
  } else if (fs.existsSync(claudeMdPath)) {
    systemPrompt += '\n\n' + fs.readFileSync(claudeMdPath, 'utf-8');
  }

  // Load global CLAUDE.md for non-main groups
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    systemPrompt += '\n\n' + fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Inject recent conversation history for context continuity
  const conversationsDir = path.join(cwd, 'conversations');
  if (fs.existsSync(conversationsDir)) {
    const MAX_FILES = 3;
    const MAX_TOTAL_CHARS = 12000; // ~3000 tokens
    const files = fs.readdirSync(conversationsDir)
      .filter((f: string) => f.endsWith('.md'))
      .sort()
      .slice(-MAX_FILES);

    if (files.length > 0) {
      let totalChars = 0;
      const snippets: string[] = [];
      // Process newest first to prioritize recent context
      for (const file of files.reverse()) {
        const content = fs.readFileSync(path.join(conversationsDir, file), 'utf-8');
        const remaining = MAX_TOTAL_CHARS - totalChars;
        if (remaining <= 0) break;
        const trimmed = content.length > remaining ? content.slice(-remaining) : content;
        snippets.unshift(trimmed);
        totalChars += trimmed.length;
      }
      systemPrompt += `\n\n## Recent Conversations\n\nBelow are your recent conversations with users in this group. Use them to maintain context continuity.\n\n${snippets.join('\n\n---\n\n')}`;
    }
  }

  // Settings: no permission prompts, auto-compaction on
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });

  // Resource loader: uses pi's DefaultResourceLoader for skill discovery
  // - /app/skills/: built-in skills baked into the container image
  // - /workspace/group/skills/: skills created by the agent at runtime (persistent)
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: '/home/node/.pi/agent',
    settingsManager,
    additionalSkillPaths: ['/app/skills', '/workspace/group/skills'],
    systemPrompt,
  });
  await resourceLoader.reload();

  // IPC tools (replaces MCP server)
  const ipcTools = createIpcTools(containerInput.chatJid, containerInput.groupFolder, containerInput.isMain);
  const webTools = createWebTools();

  const { session } = await createAgentSession({
    cwd,
    agentDir: '/home/node/.pi/agent',
    model,
    thinkingLevel: 'low',
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: createCodingTools(cwd),
    customTools: [...ipcTools, ...webTools],
    sessionManager: SessionManager.create(cwd),
    settingsManager,
  });

  return session;
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK] You are executing a scheduled task. The following is the task instruction, NOT a message from a user. Execute the task and respond with the result directly. Do NOT use the send_message tool (your response will be automatically delivered). Do NOT respond as if someone is talking to you.\n\nTask: ${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    const pendingTexts = pending.map(m => m.text).filter(Boolean);
    if (pendingTexts.length) prompt += '\n' + pendingTexts.join('\n');
    // Merge any pending images into the initial images
    const pendingImages = pending.flatMap(m => m.images || []);
    if (pendingImages.length) {
      containerInput.images = [...(containerInput.images || []), ...pendingImages.map(img => ({ data: img.data, mimeType: img.mimeType }))];
    }
  }

  try {
    const session = await createSession(containerInput);
    const sessionId = session.sessionId;
    log(`Session created: ${sessionId}`);

    // Main loop: prompt → collect result → wait for IPC → prompt again
    let currentPrompt = prompt;
    // Images only for the first prompt (from the incoming message)
    let currentImages = containerInput.images?.map(img => ({
      type: 'image' as const,
      data: img.data,
      mimeType: img.mimeType,
    }));

    while (true) {
      log(`Starting prompt (session: ${sessionId})...`);

      // Collect assistant response
      let resultText = '';
      let closedDuringQuery = false;

      // Set up IPC polling during query
      let ipcPolling = true;
      let ipcPollTimer: ReturnType<typeof setTimeout> | null = null;
      const pollIpcDuringQuery = () => {
        if (!ipcPolling) return;
        if (shouldClose()) {
          log('Close sentinel detected during query');
          closedDuringQuery = true;
          session.abort();
          ipcPolling = false;
          return;
        }
        const messages = drainIpcInput();
        for (const msg of messages) {
          if (msg.text) {
            log(`Queuing IPC follow-up message (${msg.text.length} chars)`);
            session.followUp(msg.text);
          }
        }
        ipcPollTimer = setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
      };
      ipcPollTimer = setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

      // Subscribe to events for this prompt
      let lastError = '';
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          resultText += event.assistantMessageEvent.delta;
        } else if (event.type === 'auto_retry_start') {
          log(`API error (attempt ${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`);
          lastError = event.errorMessage;
        } else if (event.type === 'auto_retry_end' && !event.success) {
          log(`API retries exhausted: ${event.finalError || lastError}`);
          lastError = event.finalError || lastError;
        }
      });

      await session.prompt(currentPrompt, currentImages?.length ? { images: currentImages } : undefined);
      currentImages = undefined; // Only send images with the first prompt
      ipcPolling = false;
      if (ipcPollTimer) clearTimeout(ipcPollTimer);
      unsubscribe();

      log(`Prompt done, result length: ${resultText.length}`);

      // Write result — if empty and there was an API error, report it
      if (!resultText && lastError) {
        log(`Prompt returned empty with API error: ${lastError}`);
        writeOutput({
          status: 'error',
          result: null,
          error: lastError,
          newSessionId: sessionId,
        });
      } else {
        writeOutput({
          status: 'success',
          result: resultText || null,
          newSessionId: sessionId,
        });
      }

      if (closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Archive transcript for audit (separate from mem extension's selective memory)
      archiveTranscript(
        session.messages
          .filter((m): m is typeof m & { role: string; content: unknown } => 'content' in m && 'role' in m)
          .map(m => ({ role: m.role as string, content: m.content })),
        containerInput.assistantName,
      );

      log('Prompt ended, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.text.length} chars, ${nextMessage.images?.length || 0} images), starting new prompt`);
      currentPrompt = nextMessage.text;
      currentImages = nextMessage.images;
    }

    session.dispose();
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
