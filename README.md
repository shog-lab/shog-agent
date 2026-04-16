# ShogAgent

**AI agents that evolve themselves — powered by LLM Wiki + Claude Code.**

Multi-agent platform where each agent maintains its own [LLM Wiki](https://github.com/luotwo/llm-wiki) (Karpathy's structured knowledge pattern), creates skills and extensions, and improves through self-reflection. Agents can invoke Claude Code on the host machine to write code, run tests, and verify results autonomously.

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Chat Channels (DingTalk / Telegram / WeChat)           │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  Host Process (Node.js)                                 │
│  Message routing · Credential proxy · IPC · Scheduler   │
│  Claude Code executor (Ralph + one-shot)                │
└──────────┬───────────┬───────────┬──────────────────────┘
           │           │           │
     ┌─────▼─────┐ ┌──▼────┐ ┌───▼─────┐
     │  Agent A   │ │Agent B│ │ Agent C │   ← Docker containers
     │            │ │       │ │         │
     │ AGENTS.md  │ │ ...   │ │ ...     │   ← persona & rules
     │ wiki/      │ │       │ │         │   ← LLM Wiki knowledge
     │ raw/       │ │       │ │         │   ← immutable sources
     │ skills/    │ │       │ │         │   ← self-created workflows
     └────────────┘ └───────┘ └─────────┘
```

Each agent runs in its own container. They can only see what's explicitly mounted. Credentials never enter containers.

## LLM Wiki

Every agent's knowledge is stored as an [LLM Wiki](https://github.com/luotwo/llm-wiki) — Karpathy's pattern of structured markdown files maintained by the LLM itself:

- **wiki/** — compiled knowledge (flat .md files with frontmatter)
- **raw/** — immutable source materials
- **schema/** — rules governing wiki quality

Five-stage lifecycle: **Ingest** → **Compile** → **Query** → **Output** → **Lint**

Pages interconnect via `[[links]]`. Search uses FTS5 + vector embeddings (Ollama). L1 memories (preferences, decisions, facts) are always injected; L2/L3 are retrieved by relevance. Knowledge graph triples enable temporal queries.

## Claude Code Integration

Agents can invoke Claude Code on the host machine through two mechanisms:

- **exec_ralph** — runs [Ralph](https://github.com/snarktank/ralph) (Claude Code in a loop) to implement PRDs. Isolated in git worktrees, never touches the main working tree.
- **exec_claude** — one-shot Claude Code execution for code review, testing, and analysis. Direct mode for black-box testing with `allowedTools` whitelist.

Full cycle: agent writes PRD → triggers Ralph → reviews code → runs black-box tests → feeds issues back for fixes → reports results.

## Self-Evolution

Agents improve themselves through an evolution loop:

1. **daily-review** — Analyze conversations, identify what went well and what didn't, fix harness
2. **autoresearch-loop** — Run experiments on retrieval quality and summary quality, keep or rollback
3. **wiki-lint** — Check wiki quality: frontmatter, dedup, stale entries, broken links
4. **code-patrol** — Proactively scan repo code for bugs and opportunities, report to user

Agents can also create skills and extensions at runtime:
- **Skills** — Markdown workflow definitions
- **Extensions** — TypeScript modules that register custom tools

## Architecture

- **~12K lines** of TypeScript — small enough to understand, modify, and trust
- **Container isolation** — each agent in its own Docker container with filesystem isolation
- **Credential proxy** — API keys injected at request time, never exposed to agents
- **File-based IPC** — simple, auditable communication between host and containers
- **Git worktree isolation** — Claude Code runs in separate worktrees, repo always safe
- **Plugin channels** — DingTalk, Telegram, WeChat; add more by implementing one interface

## Quick Start

```bash
git clone https://github.com/shog-lab/shog-agent.git
cd shog-agent
npm install
cp .env.example .env  # configure credentials
./container/build.sh   # build agent container
npm run dev
```

See `.env.example` for all configuration options.

## Supported Channels

- **DingTalk** — WebSocket (Stream mode)
- **Telegram** — Bot API (grammy)
- **WeChat** — iLink Bot API (HTTP long-polling)

Channels are plugin-based. Each self-registers at startup if credentials are present in `.env`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/claude-code.ts` | Host-side Claude Code execution (Ralph + one-shot) |
| `src/channels/*.ts` | Channel implementations |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `container/pi-agent-runner/` | Container-side agent runner |
| `container/extensions/memory/` | LLM Wiki memory system (FTS5 + vectors + KG) |
| `container/schema/` | Global wiki rules |
| `scripts/claw.ts` | CLI tool for terminal testing |

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run tests
./container/build.sh # Rebuild agent container

# Debug: send prompt to agent without DingTalk
echo "your prompt" | npx tsx scripts/claw.ts -g group-name
```

## Requirements

- macOS or Linux
- Node.js 20+
- Docker

## License

MIT
