---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# ShogAgent Container Debugging

## Architecture Overview

```
Host (macOS/Linux)                    Container (Linux)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/pi-agent-runner/
    │                                      │
    │ spawns container                     │ runs pi-coding-agent
    │ with volume mounts                   │ with IPC tools
    │                                      │
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/sessions/{folder}/.pi/agent/ ──> /home/node/.pi/agent/
    ├── ~/.pi/agent/auth.json ─────> /home/node/.pi/agent/auth.json
    ├── data/ipc/{folder} ────────> /workspace/ipc
    └── (main only) project root ──> /workspace/project (ro)
```

Built-in skills load from `/app/skills/` (baked into image).
Built-in extensions load from `/tmp/extensions/` → synced to `/home/node/.pi/agent/extensions/` on startup.
Group skills load from `/workspace/group/skills/`.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | stdout (dev) or `logs/shog-agent.log` | Host-side routing, container spawning |
| **Main app errors** | `logs/shog-agent.error.log` | Host-side errors |
| **Container run logs** | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |

## Enabling Debug Logging

```bash
LOG_LEVEL=debug npm run dev
```

Debug level shows:
- Full mount configurations
- Container command arguments
- IPC pipe events

## Common Issues

### 1. Container exits with code 125

**Docker mount failure.** Check container log for mount error details.

Common cause on macOS: VirtioFS mount issue with new groups. The auth.json placeholder fix should handle this — check that `data/sessions/{folder}/.pi/agent/auth.json` exists.

### 2. Container exits with code 1

**Agent runner error.** Check container log in `groups/{folder}/logs/container-*.log`.

Common causes:
- Missing authentication: check `~/.pi/agent/auth.json` exists
- Invalid model: check `MODEL` in `.env` (format: `provider/model-name`)
- Missing credentials in `.env`

### 3. Messages not getting responses

Check in order:
1. Is ShogAgent running? `ps aux | grep "tsx src/index"`
2. Is there only ONE process? Multiple processes = duplicate handling
3. Check logs for `New messages` — is the message being detected?
4. Check for `Piped messages` or `No active container, enqueueing` — is it being processed?
5. Check container logs in `groups/{folder}/logs/`

### 4. IPC messages lost (macOS Docker)

VirtioFS file sync can be delayed. If container logs show `ENOENT` errors for IPC files, the fix is already in place (skip and retry on next poll). If messages still get lost:

```bash
# Check if IPC files are stuck
ls -la data/ipc/{folder}/input/

# Check container is polling
docker logs <container-name> 2>&1 | tail -20
```

### 5. Duplicate responses

Two possible causes:
1. **Multiple host processes** — kill all and restart one: `kill $(ps aux | grep "tsx src/index" | grep -v grep | awk '{print $2}')`
2. **Container retry after error** — check logs for `rolled back message cursor for retry`

### 6. Agent doesn't know its skills

Skills are loaded from two paths:
- `/app/skills/` — built-in (from container image)
- `/workspace/group/skills/` — group-specific (from host)

Check what the container sees:
```bash
docker exec <container-id> ls /app/skills/
docker exec <container-id> ls /workspace/group/skills/ 2>/dev/null
```

## Manual Container Testing

```bash
# Test query
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test","isMain":false}' | \
  docker run -i --rm \
  -v $(pwd)/groups/test:/workspace/group \
  -v ~/.pi/agent/auth.json:/home/node/.pi/agent/auth.json \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:3001 \
  -e ANTHROPIC_API_KEY=placeholder \
  --add-host=host.docker.internal:host-gateway \
  shog-agent-agent:latest

# Interactive shell
docker run --rm -it --entrypoint /bin/bash shog-agent-agent:latest

# Check container contents
docker run --rm --entrypoint /bin/bash shog-agent-agent:latest -c '
  node --version
  ls /app/skills/
  ls /tmp/extensions/
'
```

## CLI Testing

Use `scripts/claw.ts` to test agents from the terminal:

```bash
npx tsx scripts/claw.ts --list-groups
npx tsx scripts/claw.ts -g <group> "your prompt"
```

## Rebuilding

```bash
npm run build            # Rebuild host TypeScript
./container/build.sh     # Rebuild container image
# Or force clean rebuild:
docker builder prune -af
./container/build.sh
```

## Quick Diagnostic

```bash
echo "=== ShogAgent Diagnostics ==="

echo -e "\n1. Credentials?"
[ -f .env ] && grep -qE '(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' .env && echo "OK" || echo "MISSING"

echo -e "\n2. Auth token?"
[ -f ~/.pi/agent/auth.json ] && echo "OK" || echo "MISSING"

echo -e "\n3. Docker running?"
docker info &>/dev/null && echo "OK" || echo "NOT RUNNING"

echo -e "\n4. Container image?"
docker image inspect shog-agent-agent:latest &>/dev/null && echo "OK" || echo "MISSING - run ./container/build.sh"

echo -e "\n5. Host process?"
PROCS=$(ps aux | grep "tsx src/index" | grep -v grep | wc -l)
echo "$PROCS process(es)"

echo -e "\n6. Active containers?"
docker ps --filter "name=shog-agent" --format "{{.Names}} ({{.Status}})"

echo -e "\n7. Recent container logs?"
ls -t groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "None"
```
