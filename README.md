# ShogAgent

**Memory-driven AI agent platform powered by LLM Wiki + pi-coding-agent.**

Multi-agent platform where each agent maintains its own [LLM Wiki](https://github.com/luotwo/llm-wiki) (Karpathy's structured knowledge pattern), creates skills and extensions, and improves through self-reflection. Code tasks run through the L1 → L2 model: L1 plans, L2 executes inside mounted repos.

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Chat Channels (DingTalk / Telegram / WeChat)           │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  Host Process (Node.js)                                 │
│  Message routing · Credential proxy · IPC · Scheduler   │
│  Container orchestration                                │
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
- **raw/** — source materials and operational traces (sources, conversations, logs, artifacts, images)
- **schema/** — rules governing wiki quality

Five-stage lifecycle: **Ingest** → **Compile** → **Query** → **Output** → **Lint**

Pages interconnect via `[[links]]`. Search uses FTS5 + vector embeddings (Ollama). L1 memories (preferences, decisions, facts) are always injected; L2/L3 are retrieved by relevance. Knowledge graph triples enable temporal queries.

## Code Execution Model

Code tasks use a two-layer model:

- **L1 (Group Agent)** plans, decomposes work, and prepares PRD / execution instructions
- **L2 (Repo Sub-Agent / Executor)** runs inside the mounted repo as L1's execution sub-agent, writes PRD / progress files when needed, modifies code, and runs verification

Rule: repo writes are done by L2, not by L1.

## Self-Evolution

Agents improve themselves through an evolution loop:

1. **meta-triage** — Triage governance requests and reported issues from other groups
2. **daily-audit** — Audit group changes and rollback bad ones
3. **wiki-lint** — Check wiki quality: frontmatter, dedup, stale entries, broken links

Agents can also create skills and extensions at runtime:
- **Skills** — Markdown workflow definitions
- **Extensions** — TypeScript modules that register custom tools

## Architecture

- **~12K lines** of TypeScript — small enough to understand, modify, and trust
- **Container isolation** — each agent in its own Docker container with filesystem isolation
- **Credential proxy** — API keys injected at request time, never exposed to agents
- **File-based IPC** — simple, auditable communication between host and containers
- **Layered execution** — L1 plans, L2 executes inside mounted repos
- **Plugin channels** — DingTalk, Telegram, WeChat; add more by implementing one interface

## Quick Start

```bash
git clone https://github.com/shog-lab/shog-agent.git
cd shog-agent
npm install
cp .env.example .env  # configure credentials
./container/build.sh   # build agent container
pm2 start "npm run dev" --name shog-agent
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
| `src/container-runner.ts` | Spawns agent containers and mounts repos |
| `src/channels/*.ts` | Channel implementations |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `container/system-prompt.md` | Container-side system prompt |
| `container/extensions/memory/` | LLM Wiki memory system (FTS5 + vectors + KG) |
| `container/schema/` | Global wiki rules |
| `scripts/cli.ts` | CLI tool for terminal testing |

## Development

```bash
npm run dev          # Run with hot reload during local development
npm run build        # Compile TypeScript
npm test             # Run tests
./container/build.sh # Rebuild agent container
pm2 restart shog-agent  # Restart the managed service after host-side changes

# Debug: send prompt to agent without DingTalk
echo "your prompt" | npx tsx scripts/cli.ts -g group-name
```

## Requirements

- macOS or Linux
- Node.js 20+
- Docker

## License

MIT
