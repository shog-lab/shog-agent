---
name: restart
description: Restart ShogAgent. Use when code changes need a restart, or the user asks to restart.
---

# Restart ShogAgent

ShogAgent is managed by PM2. Use PM2 commands to restart.

## Steps

1. Kill running containers and restart via PM2:

```bash
docker kill $(docker ps -q --filter "name=shog-agent") 2>/dev/null
pm2 restart shog-agent
```

2. Verify:

```bash
pm2 status shog-agent
```

Should show `online`.
