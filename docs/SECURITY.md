# ShogAgent Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Incoming messages | User input | Potential prompt injection |
| exec_ralph | Sandboxed | Runs in git worktree, never touches main working tree |
| exec_claude | Restricted | Direct mode: allowedTools whitelist; worktree mode: disallowedTools |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/shog-agent/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups
- `codeReposReadOnly` option for read-only code repo mounts

### 3. Claude Code Execution Security

Agent containers can trigger Claude Code on the host via IPC (`exec_ralph`, `exec_claude`). Multiple layers of protection:

**Validation (src/claude-code.ts):**
- Repo must be in group's `codeRepos` whitelist
- Working tree must be clean (tracked files only — untracked files ignored)
- Risk scorer evaluates operation risk before execution

**exec_ralph — worktree isolation:**
- Creates a git worktree in a separate directory, never touches main working tree
- Branch reuse for review→fix loops (same branch, fresh worktree)
- Worktree auto-cleaned after execution (branch preserved for review)

**exec_claude — two modes:**
- **Worktree mode** (default): `--disallowedTools Write,Edit,NotebookEdit` — can read and run commands but cannot modify files
- **Direct mode** (`useWorktree=false`): `--allowedTools` whitelist restricts to safe operations only (read, verify, browser). Used for black-box testing
- Both modes: `--dangerously-skip-permissions` is safe because tool restrictions are enforced via allowedTools/disallowedTools

**Tool whitelist (direct mode, src/verify-command.ts):**
- Read tools: Read, Glob, Grep
- Safe bash: cat, ls, head, tail, find, echo, wc, diff, grep, sort
- Verify: pnpm test, npm test, pytest, cargo test, go test
- Browser: agent-browser
- Git read-only: git log, git diff, git show, git status
- No: Write, Edit, rm, git push, git checkout, git reset

**Risk scorer (src/risk-scorer.ts):**
- 4-axis scoring: tool risk (1-5), file sensitivity (1-5), impact scope (1-5), reversibility (1-5)
- Total 4-20: LOW (4-8) proceed, MEDIUM (9-14) warn, HIGH (15+) block
- Configurable threshold via GovernanceConfig.riskThreshold
- Sensitive file patterns: .env(5), package.json(4), Dockerfile(3), src/(2), test/(1)

**Artifacts isolation:**
- exec_claude direct mode stores screenshots in `groups/{group}/artifacts/`, not in repo
- Auto-cleaned before each run

### 4. Governance Config

Per-group execution constraints (`ContainerConfig.governance`):

```typescript
{
  maxIterations: 20,        // Ralph max iterations
  ralphTimeoutMinutes: 60,  // Ralph timeout
  claudeTimeoutMinutes: 30, // exec_claude timeout
  riskThreshold: 15         // Block operations scoring above this
}
```

Defaults apply when not configured. Groups can override for stricter or looser constraints.

### 5. Session Isolation

Each group has isolated sessions at `data/sessions/{group}/.pi/agent/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 6. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |
| exec_ralph / exec_claude | ✓ | ✓ (own codeRepos only) |

### 7. Credential Isolation (Credential Proxy)

Real API credentials **never enter containers**. The container runner sets `ANTHROPIC_BASE_URL` to route API traffic through a local proxy that injects credentials at request time.

**NOT Mounted:**
- Channel auth sessions — host only
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                            │
│  Incoming Messages (potentially malicious)                       │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                               │
│  • IPC authorization                                             │
│  • Mount validation (external allowlist)                         │
│  • Container lifecycle                                           │
│  • Credential proxy                                              │
│  • Claude Code executor (exec_ralph / exec_claude)               │
│    - Repo whitelist + dirty check + risk scorer                  │
│    - Worktree isolation for Ralph                                │
│    - AllowedTools whitelist for direct mode                      │
│    - GovernanceConfig constraints                                │
└─────────────┬──────────────────────────┬────────────────────────┘
              │                          │
              ▼ Explicit mounts only     ▼ Worktree (isolated)
┌─────────────────────────┐  ┌────────────────────────────────────┐
│  CONTAINER (SANDBOXED)  │  │  CLAUDE CODE (HOST, RESTRICTED)    │
│  • Agent execution      │  │  • exec_ralph: worktree + branch   │
│  • File ops (mounts)    │  │  • exec_claude: allowedTools only  │
│  • API via proxy        │  │  • Artifacts → group/artifacts/    │
│  • No real credentials  │  │  • Risk scored before execution    │
└─────────────────────────┘  └────────────────────────────────────┘
```
