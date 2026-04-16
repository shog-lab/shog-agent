---
name: restart
description: Restart ShogAgent. Use when code changes need a restart, or the user asks to restart.
---

# Restart ShogAgent

Kill all existing ShogAgent processes and containers, then start fresh.

## Steps

1. Kill existing processes and containers:

```bash
kill $(ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}') 2>/dev/null
docker kill $(docker ps -q --filter "name=shog-agent") 2>/dev/null
```

2. Wait for cleanup:

```bash
sleep 5
```

3. Start dev server in background:

```bash
npm run dev
```

Run this as a background task so it doesn't block.

4. Verify single process is running:

```bash
ps aux | grep "tsx src/index" | grep -v grep | wc -l
```

Should output `1`. If more than 1, kill all and retry.
