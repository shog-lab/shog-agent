---
name: setup
description: Run initial ShogAgent setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure shog-agent", or first-time setup requests.
---

# ShogAgent Setup

Run setup steps automatically. Only pause when user action is required (channel authentication, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx scripts/setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 20+?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.

## 2. Check Environment

Run `npx tsx scripts/setup/index.ts --step environment` and parse the status block.

- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record DOCKER value for step 3

## 2a. Timezone

Run `npx tsx scripts/setup/index.ts --step timezone` and parse the status block.

- If NEEDS_USER_INPUT=true → AskUserQuestion: "What is your timezone?" with common options (America/New_York, Europe/London, Asia/Shanghai, Asia/Tokyo) and an "Other" escape. Then re-run: `npx tsx scripts/setup/index.ts --step timezone -- --tz <their-answer>`.
- If STATUS=success → Timezone is configured. Note RESOLVED_TZ for reference.

## 3. Container Runtime (Docker)

### 3a. Install Docker

- DOCKER=running → continue to step 4
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Build and test

Run `npx tsx scripts/setup/index.ts --step container -- --runtime docker` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f`. Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Credentials

ShogAgent uses a local credential proxy — API keys are stored in `.env` and injected into container API requests at runtime. Containers never see raw credentials.

Check if `.env` already has a credential:
```bash
grep -qE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' .env 2>/dev/null && echo "configured" || echo "missing"
```

If configured, confirm with user: keep or reconfigure? If keeping, skip to step 5.

AskUserQuestion: Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription. You'll run `claude setup-token` in another terminal to get your token."
2. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com."

### Subscription path

Tell the user to run `claude setup-token` in another terminal and copy the token it outputs. Do NOT collect the token in chat.

Once they have the token, add it to `.env`:
```bash
sed -i.bak '/^CLAUDE_CODE_OAUTH_TOKEN=/d' .env 2>/dev/null
echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" >> .env
```

### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one.

Once they have the key, add it to `.env`:
```bash
sed -i.bak '/^ANTHROPIC_API_KEY=/d' .env 2>/dev/null
echo "ANTHROPIC_API_KEY=<key>" >> .env
```

### After either path

**If the user's response happens to contain a token or key** (starts with `sk-ant-`): handle it gracefully — write it to `.env` on their behalf.

**After user confirms:** verify with `grep -qE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' .env` that a credential exists. If not, ask again.

## 5. Set Up Channels

AskUserQuestion: Which messaging channel do you want to enable?
- DingTalk (requires App Key + App Secret from DingTalk developer console)
- Telegram (requires bot token from @BotFather)

### DingTalk

Collect DingTalk App Key and App Secret, write to `.env`:
```bash
echo "DINGTALK_APP_KEY=<key>" >> .env
echo "DINGTALK_APP_SECRET=<secret>" >> .env
```

### Telegram

Collect Telegram Bot Token, write to `.env`:
```bash
echo "TELEGRAM_BOT_TOKEN=<token>" >> .env
```

After configuring, rebuild and restart:
```bash
npm install && npm run build
```

## 6. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx scripts/setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx scripts/setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 7. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.shog-agent.plist`
- Linux: `systemctl --user stop shog-agent` (or `systemctl stop shog-agent` if root)

Run `npx tsx scripts/setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-shog-agent.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`).

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep shog-agent`. If PID=`-` and status non-zero, read `logs/shog-agent.error.log`.
- Linux: check `systemctl --user status shog-agent`.
- Re-run the service step after fixing.

## 8. Verify

Run `npx tsx scripts/setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.shog-agent` (macOS) or `systemctl --user restart shog-agent` (Linux) or `bash start-shog-agent.sh` (WSL nohup)
- SERVICE=not_found → re-run step 7
- CREDENTIALS=missing → re-run step 4 (check `.env` for `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`)
- REGISTERED_GROUPS=0 → re-run step 5
- MOUNT_ALLOWLIST=missing → `npx tsx scripts/setup/index.ts --step mounts -- --empty`

Tell user to test: send a message in their registered chat. Show: `tail -f logs/shog-agent.log`

## Troubleshooting

**Service not starting:** Check `logs/shog-agent.error.log`. Common: wrong Node path (re-run step 7), missing credentials in `.env` (re-run step 4), missing channel credentials.

**Container agent fails:** Ensure Docker is running — `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Check container logs in `groups/*/logs/container-*.log`.

**No response to messages:** Check trigger pattern (`ASSISTANT_NAME` in `.env`). Main channel doesn't need prefix. Check DB: `npx tsx scripts/setup/index.ts --step verify`. Check `logs/shog-agent.log`.

**Channel not connecting:** Verify the channel's credentials are set in `.env`. Channels auto-enable when their credentials are present. Restart the service after any `.env` change.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.shog-agent.plist` | Linux: `systemctl --user stop shog-agent`
