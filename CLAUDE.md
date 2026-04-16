# ShogAgent

Memory-driven AI agent platform with LLM Wiki, self-evolution, and Claude Code integration. See [docs/PI_ARCHITECTURE.md](docs/PI_ARCHITECTURE.md) for architecture and changelog.

## Quick Context

Single Node.js process with plugin channels (DingTalk, WeChat). Messages route to pi-coding-agent running in Docker containers. Each group has isolated filesystem and memory. Agent self-evolves via evolution skill.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/dingtalk.ts` | DingTalk WebSocket channel |
| `src/channels/weixin.ts` | WeChat iLink Bot API channel |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/claude-code.ts` | Host-side Claude Code execution (execRalph + execClaude) |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `container/pi-agent-runner/` | Container-side agent runner (pi-coding-agent) |
| `container/skills/` | Skills loaded inside agent containers |
| `groups/{name}/AGENTS.md` | Per-group agent persona (isolated) |

## Credentials

API keys and OAuth tokens are stored in `.env` on the host. The container runner sets `ANTHROPIC_BASE_URL` to route API traffic through a local credential proxy — containers never see raw keys.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

## Debugging

用 CLI 直接发 prompt 给 agent 容器，不需要通过钉钉：

```bash
echo "你的 prompt" | npx tsx scripts/cli.ts <group-name>
# 例如：
echo "对 yt-dubbing 跑黑盒测试" | npx tsx scripts/cli.ts dingtalk-harness
echo "你好" | npx tsx scripts/cli.ts dingtalk-shog
```

调试时优先用 CLI（scripts/cli.ts），不要浪费用户时间让他在钉钉里触发。

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
