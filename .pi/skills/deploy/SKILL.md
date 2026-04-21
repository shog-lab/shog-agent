---
name: deploy
description: Build TypeScript, rebuild container image, and restart ShogAgent. Use after code or container changes.
---

# Deploy ShogAgent

Full build + restart cycle. Use when source code, container image, or skills have changed.

## Steps

1. Build TypeScript:

```bash
npm run build
```

If build fails, fix the error before proceeding.

2. Rebuild container image:

```bash
./container/build.sh
```

3. Restart ShogAgent (use the restart skill):

Kill all existing processes and containers, wait, then start fresh. Verify single process is running.
