---
name: restart
description: Restart ShogAgent. Use when code changes need a restart, or the user asks to restart.
---

# Restart ShogAgent

ShogAgent is managed by PM2.

## Rules

- Restart only via PM2.
- Do not use `nohup npm run dev`, background shell launches, or other manual dev-mode restart paths.
- After restarting, verify the PM2 process is `online`.

## Steps

```bash
docker kill $(docker ps -q --filter "name=shog-agent") 2>/dev/null
pm2 restart shog-agent
pm2 status shog-agent
```
