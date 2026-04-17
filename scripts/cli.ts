#!/usr/bin/env npx tsx
/**
 * cli — ShogAgent CLI
 * Send prompts to agent containers from the terminal.
 */

import { execSync, spawn } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Paths ──

const PROJECT_ROOT = path.resolve(
  process.env.SHOG_AGENT_DIR || path.join(import.meta.dirname, '..'),
);
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'messages.db');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const IMAGE = process.env.CONTAINER_IMAGE || 'shog-agent:latest';


// ── .env reader ──

function readEnvFile(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(ENV_FILE)) return result;
  const content = fs.readFileSync(ENV_FILE, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (keys.includes(key)) result[key] = val;
  }
  return result;
}

// ── Database ──

interface Group {
  jid: string;
  name: string;
  folder: string;
  isMain: boolean;
}

function getGroups(): Group[] {
  if (!fs.existsSync(DB_PATH)) return [];
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare(
      'SELECT jid, name, folder, is_main FROM registered_groups ORDER BY name',
    )
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    is_main: number;
  }>;
  db.close();
  return rows.map((r) => ({
    jid: r.jid,
    name: r.name,
    folder: r.folder,
    isMain: r.is_main === 1,
  }));
}

function findGroup(groups: Group[], query: string): Group | null {
  const q = query.toLowerCase();
  const exact = groups.find(
    (g) => g.name.toLowerCase() === q || g.folder.toLowerCase() === q,
  );
  if (exact) return exact;
  const matches = groups.filter(
    (g) => g.name.toLowerCase().includes(q) || g.folder.toLowerCase().includes(q),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const names = matches.map((g) => `"${g.name}"`).join(', ');
    console.error(`error: ambiguous group '${query}'. Matches: ${names}`);
    process.exit(1);
  }
  return null;
}

// ── Container runtime ──

function detectRuntime(override?: string): string {
  if (override) return override;
  for (const rt of ['docker', 'container']) {
    try {
      execSync(`${rt} info`, { stdio: 'ignore' });
      return rt;
    } catch {
      continue;
    }
  }
  console.error("error: neither 'docker' nor 'container' found");
  process.exit(1);
}

// ── Build container args (mirrors container-runner.ts) ──

function buildContainerArgs(
  runtime: string,
  folder: string,
  isMain: boolean,
  image: string,
  chatJid: string,
): string[] {
  const args = [runtime, 'run', '-i', '--rm'];
  const groupDir = path.join(GROUPS_DIR, folder);
  const groupPiDir = path.join(DATA_DIR, 'sessions', folder, '.pi', 'agent');
  const ipcDir = path.join(DATA_DIR, 'ipc', folder);

  // Ensure directories exist
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(groupPiDir, { recursive: true });
  for (const sub of ['messages', 'tasks']) {
    fs.mkdirSync(path.join(ipcDir, sub), { recursive: true });
  }

  // Environment variables
  const env = readEnvFile([
    'MODEL',
    'MINIMAX_API_KEY',
    'MINIMAX_CN_API_KEY',
    'JIMENG_ACCESS_KEY',
    'JIMENG_SECRET_KEY',
    'WECHAT_APPID',
    'WECHAT_SECRET',
  ]);

  args.push('-e', 'TZ=Asia/Shanghai');
  args.push('-e', 'ANTHROPIC_BASE_URL=http://host.docker.internal:3001');
  args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  args.push('-e', `CHAT_JID=${chatJid}`);
  args.push('-e', `GROUP_FOLDER=${folder}`);
  args.push('-e', `IS_MAIN=${isMain}`);
  for (const [key, val] of Object.entries(env)) {
    if (val) args.push('-e', `${key}=${val}`);
  }

  // Host gateway
  if (runtime === 'docker') {
    args.push('--add-host=host.docker.internal:host-gateway');
  }

  // User mapping
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid != null && uid !== 0 && uid !== 1000) {
    args.push('--user', `${uid}:${gid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Mounts
  if (isMain) {
    args.push(
      '--mount',
      `type=bind,source=${PROJECT_ROOT},target=/workspace/project,readonly`,
    );
    const envFile = path.join(PROJECT_ROOT, '.env');
    if (fs.existsSync(envFile)) {
      args.push(
        '--mount',
        `type=bind,source=/dev/null,target=/workspace/project/.env,readonly`,
      );
    }
  }

  args.push('-v', `${groupDir}:/workspace/group`);
  args.push('-v', `${groupPiDir}:/home/node/.pi/agent`);
  args.push('-v', `${ipcDir}:/workspace/ipc`);

  // auth.json
  const hostAuth = path.join(os.homedir(), '.pi', 'agent', 'auth.json');
  if (fs.existsSync(hostAuth)) {
    const placeholder = path.join(groupPiDir, 'auth.json');
    if (!fs.existsSync(placeholder)) fs.writeFileSync(placeholder, '{}');
    args.push('-v', `${hostAuth}:/home/node/.pi/agent/auth.json`);
  }

  args.push(image);
  return args;
}

// ── Run container ──

function runContainer(
  args: string[],
  prompt: string,
  timeout: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(args[0], args.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Send RPC prompt command (do NOT close stdin — pi needs it open)
    proc.stdin.write(JSON.stringify({ type: 'prompt', message: prompt }) + '\n');

    let lineBuffer = '';
    let resultText = '';
    let done = false;
    let timer: ReturnType<typeof setTimeout>;

    proc.stderr.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (line && !line.startsWith('npm notice')) {
          process.stderr.write(line + '\n');
        }
      }
    });

    proc.stdout.on('data', (data) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Accumulate assistant text from text_delta events
          if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
            resultText += event.assistantMessageEvent.delta;
          }
          // agent_end = agent finished processing the prompt
          if (event.type === 'agent_end' && !done) {
            done = true;
            clearTimeout(timer);
            if (resultText) console.log(resultText);
            proc.stdin.end();
            proc.kill('SIGTERM');
            setTimeout(() => proc.kill('SIGKILL'), 5000);
          }
        } catch {
          // Non-JSON line, ignore
        }
      }
    });

    proc.on('close', () => {
      clearTimeout(timer);
      if (!done && resultText) {
        console.log(resultText);
      }
      resolve();
    });

    proc.on('error', reject);

    timer = setTimeout(() => {
      if (!done) {
        proc.kill('SIGKILL');
        console.error(`error: timed out after ${timeout}s`);
        process.exit(1);
      }
    }, timeout * 1000);
  });
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list-groups')) {
    const groups = getGroups();
    console.log(
      `${'NAME'.padEnd(35)} ${'FOLDER'.padEnd(30)} JID`,
    );
    console.log('-'.repeat(100));
    for (const g of groups) {
      const tag = g.isMain ? ' [main]' : '';
      console.log(
        `${g.name.padEnd(35)} ${g.folder.padEnd(30)} ${g.jid}${tag}`,
      );
    }
    return;
  }

  // Parse args
  let groupQuery: string | undefined;
  let jid: string | undefined;
  let sessionId: string | undefined;
  let runtimeOverride: string | undefined;
  let timeout = 300;
  let verbose = false;
  let pipe = false;
  const promptParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-g':
      case '--group':
        groupQuery = args[++i];
        break;
      case '-j':
      case '--jid':
        jid = args[++i];
        break;
      case '-s':
      case '--session':
        sessionId = args[++i];
        break;
      case '--runtime':
        runtimeOverride = args[++i];
        break;
      case '--timeout':
        timeout = parseInt(args[++i], 10);
        break;
      case '-v':
      case '--verbose':
        verbose = true;
        break;
      case '-p':
      case '--pipe':
        pipe = true;
        break;
      default:
        if (!args[i].startsWith('-')) promptParts.push(args[i]);
    }
  }

  // Read prompt
  let prompt = promptParts.join(' ');
  if (pipe || (!process.stdin.isTTY && !prompt)) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const stdinText = Buffer.concat(chunks).toString().trim();
    prompt = prompt ? `${prompt}\n\n${stdinText}` : stdinText;
  }

  if (!prompt) {
    console.error(
      'usage: cli [-g group] [-s session] [--pipe] [--timeout N] "prompt"',
    );
    process.exit(1);
  }

  // Resolve group
  const groups = getGroups();
  let group: Group | undefined;

  if (groupQuery) {
    const found = findGroup(groups, groupQuery);
    if (!found) {
      console.error(
        `error: group '${groupQuery}' not found. Run --list-groups`,
      );
      process.exit(1);
    }
    group = found;
  } else if (jid) {
    group = groups.find((g) => g.jid === jid);
  } else {
    group = groups.find((g) => g.isMain);
    if (!group) {
      console.error('error: no group specified and no main group found');
      process.exit(1);
    }
  }

  const runtime = detectRuntime(runtimeOverride);
  const containerArgs = buildContainerArgs(
    runtime,
    group!.folder,
    group!.isMain,
    IMAGE,
    group!.jid,
  );

  if (verbose) {
    console.error(`[${group!.name}] ${containerArgs.join(' ')}`);
  }

  console.error(`[${group!.name}] running via ${runtime}...`);

  await runContainer(containerArgs, prompt, timeout);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
