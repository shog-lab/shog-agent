---
name: customize
description: Add new capabilities or modify ShogAgent behavior. Use when user wants to add channels, change triggers, add integrations, or make other customizations. Interactive — asks questions to understand what the user wants.
---

# ShogAgent Customization

This skill helps users add capabilities or modify behavior. Use AskUserQuestion to understand what they want before making changes.

## Workflow

1. **Understand the request** — Ask clarifying questions
2. **Plan the changes** — Identify files to modify
3. **Implement** — Make changes directly to the code
4. **Test guidance** — Tell user how to verify

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/*.ts` | Channel implementations (DingTalk, Telegram, WeChat) |
| `src/channels/registry.ts` | Channel self-registration |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/group-queue.ts` | Per-group queue with concurrency control |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/types.ts` | TypeScript interfaces (includes Channel) |
| `src/config.ts` | Assistant name, trigger pattern, directories |
| `src/db.ts` | SQLite operations |
| `container/pi-agent-runner/src/index.ts` | Container-side agent runner (system prompt, session management) |
| `container/skills/` | Built-in skills (shared across all groups) |
| `container/extensions/` | Built-in extensions (memory, jimeng) |

## Common Customization Patterns

### Adding a New Channel

Questions to ask:
- Which channel?
- Same trigger word or different?
- Token-based auth or interactive (QR code)?

Implementation:
1. Create `src/channels/{name}.ts` implementing the `Channel` interface from `src/types.ts`
2. Call `registerChannel()` at the bottom of the file (see `src/channels/dingtalk.ts` for reference)
3. Import it in `src/channels/index.ts`
4. Add credentials to `.env.example`
5. Install any SDK dependencies (`npm install`)

### Adding Environment Variables to Containers

If a new skill or extension needs API keys:

1. In `src/container-runner.ts`, add `readEnvFile` + `args.push('-e', ...)` (see existing JIMENG/WECHAT patterns)
2. Add the key to `.env.example`

### Changing Agent Behavior (All Groups)

Edit `container/pi-agent-runner/src/index.ts` — the system prompt section. Then rebuild the container image.

### Changing Agent Behavior (One Group)

Edit that group's `AGENTS.md` or add a skill to `groups/{folder}/skills/`.

### Adding a Built-in Skill

1. Create `container/skills/{name}/SKILL.md`
2. Rebuild container image: `./container/build.sh`

### Adding a Built-in Extension

1. Create `container/extensions/{name}/index.ts` (+ `package.json` if dependencies needed)
2. Rebuild container image: `./container/build.sh`

### Changing the Trigger Word

Edit `ASSISTANT_NAME` in `.env`. The trigger pattern is `@{ASSISTANT_NAME}`.

## After Changes

```bash
# Host code changes:
npm run build

# Container changes (system prompt, skills, extensions):
./container/build.sh

# Then restart:
# Kill existing processes and containers, start fresh
```

Or use `/deploy` to do all three steps.
