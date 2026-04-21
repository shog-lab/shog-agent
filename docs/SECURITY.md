# ShogAgent Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Incoming messages | User input | Potential prompt injection |
| L2 executor | Restricted | Runs only inside mounted repos and inherits container mount permissions |

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

### 3. Repo Execution Security

Code execution happens inside the group container via L2 (`pi -p`). Security comes from mount permissions and container isolation.

**Protections:**
- Repo must be in the group's `codeRepos` whitelist
- L2 inherits the container's mount permissions and cannot write outside mounted repos
- Read-only repo mounts remain read-only for both L1 and L2
- L1 plans work, but repo writes are performed by L2
- PRD / progress files are also written by L2 if they need to live inside the repo

### 4. Governance Config

Per-group execution constraints (`ContainerConfig.governance`):

```typescript
{
  maxIterations: 20,
  riskThreshold: 15
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
| L2 repo execution | ✓ | ✓ (own codeRepos only) |

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
│  • Repo whitelist + mount validation                             │
│  • Container lifecycle                                           │
│  • GovernanceConfig constraints                                  │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼ Explicit mounts only
┌──────────────────────────────────────────────────────────────────┐
│  CONTAINER (SANDBOXED)                                          │
│  • L1 plans                                                     │
│  • L2 executes inside mounted repos                             │
│  • File ops constrained by mount permissions                    │
│  • API via proxy                                                │
│  • No real credentials                                          │
└──────────────────────────────────────────────────────────────────┘
```
