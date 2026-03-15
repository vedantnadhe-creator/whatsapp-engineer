# Claude Code Integrations Setup Guide

Complete guide to set up all MCP servers, plugins, skills, and hooks for the WhatsApp Engineer (OliBot) deployment.

---

## MCP Servers

MCP (Model Context Protocol) servers extend Claude Code with external tool access. There are two types:

- **Claude.ai built-in** — Managed by Anthropic, enabled in Claude Code settings. Authenticate via `claude mcp auth`.
- **Custom/self-hosted** — Run as local processes via stdio transport, configured in `~/.claude/settings.json`.

### Built-in MCP Servers (claude.ai)

These are toggled on in the Claude Code app or via settings. No install needed — just authenticate.

| Server | What it does | Auth |
|--------|-------------|------|
| **GitHub** | Repos, PRs, issues, code search, commits | GitHub OAuth |
| **Slack** | Search messages, read channels/threads, send messages | Slack OAuth |
| **Linear** | Issues, projects, milestones, documents, teams | Linear OAuth |
| **Jira** | Issues, sprints, boards, projects, worklogs | Atlassian OAuth |
| **Notion** | Pages, databases, blocks, comments, search | Notion OAuth |

**Enable in Claude Code:**
```bash
# Authenticate each service
claude mcp auth slack
claude mcp auth linear
claude mcp auth jira
claude mcp auth notion
```

Or enable via the Claude Code UI: Settings > MCP Servers > Toggle on.

### Self-Hosted MCP Servers

These run as local processes. Add to `~/.claude/settings.json` under `"mcpServers"`.

#### PostgreSQL
Direct SQL query access to databases.

```bash
# Install
npm install -g @anthropic-ai/mcp-server-postgres
```

Add to `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "postgres": {
      "command": "mcp-server-postgres",
      "args": ["postgresql://user:pass@host:5432/dbname"]
    }
  }
}
```

- **Repo:** https://github.com/anthropics/mcp-server-postgres
- **Tools:** `query` — execute SQL

#### WhatsApp (Baileys)
Send/receive WhatsApp messages, check connection status.

```bash
# Install
npm install -g @anthropic-ai/mcp-server-whatsapp
```

Add to settings:
```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "mcp-server-whatsapp",
      "args": []
    }
  }
}
```

- **Tools:** `send_message`, `send_media`, `get_messages`, `get_chats`, `check_connection_status`, `get_qr_code`

#### Browser Agent
Headless browser automation — browse pages, run tasks, capture screenshots.

```bash
# Install
npm install -g @anthropic-ai/mcp-server-browser-agent
```

Add to settings:
```json
{
  "mcpServers": {
    "browser-agent": {
      "command": "mcp-server-browser-agent",
      "args": []
    }
  }
}
```

- **Tools:** `browse_page`, `run_browser_task`, `get_network_logs`

#### S3 Upload
Upload files to Amazon S3 buckets.

```bash
npm install -g @anthropic-ai/mcp-server-s3-upload
```

Add to settings:
```json
{
  "mcpServers": {
    "s3-upload": {
      "command": "mcp-server-s3-upload",
      "env": {
        "AWS_ACCESS_KEY_ID": "your-key",
        "AWS_SECRET_ACCESS_KEY": "your-secret",
        "S3_BUCKET": "your-bucket",
        "S3_REGION": "us-east-1"
      }
    }
  }
}
```

- **Tools:** `upload_file`

#### Custom: PluginLive Assessment
Custom MCP server for PluginLive assessment platform.

```json
{
  "mcpServers": {
    "pluginlive-assessment": {
      "command": "node",
      "args": ["/path/to/mcp-pluginlive-assessment/dist/main.js"],
      "env": {
        "TRANSPORT": "stdio",
        "PLUGINLIVE_API_BASE": "https://api-admin.dev.pluginlive.com",
        "PLUGINLIVE_AUTH_BASE": "https://api-auth.dev.pluginlive.com",
        "PLUGINLIVE_EMAIL": "your-email",
        "PLUGINLIVE_PASSWORD": "your-password"
      }
    }
  }
}
```

---

## Plugins

Plugins add capabilities to Claude Code. Install via marketplace or GitHub.

### Installed Plugins

| Plugin | Source | What it does |
|--------|--------|-------------|
| **ralph-wiggum** | `claude-code-plugins` marketplace | Continuous self-referential AI loop technique |
| **CLI-Anything** | GitHub: `HKUDS/CLI-Anything` | Stateful CLI interface harness for GUI apps |

### Official Marketplace Plugins (Available)

These are in the `claude-plugins-official` marketplace. Enable any with:
```bash
claude plugin enable <plugin-name>
```

| Plugin | Purpose |
|--------|---------|
| `agent-sdk-dev` | Claude Agent SDK development tools |
| `code-review` | Automated code review |
| `code-simplifier` | Simplify complex code |
| `commit-commands` | Git commit helpers |
| `feature-dev` | Feature development workflow |
| `frontend-design` | Frontend design patterns |
| `hookify` | Create Claude Code hooks |
| `pr-review-toolkit` | Pull request review tools |
| `security-guidance` | Security best practices |
| `skill-creator` | Create custom skills |

### LSP Plugins (Language Servers)

Provide IDE-level intelligence for specific languages:

| Plugin | Language |
|--------|----------|
| `typescript-lsp` | TypeScript/JavaScript |
| `pyright-lsp` | Python |
| `rust-analyzer-lsp` | Rust |
| `gopls-lsp` | Go |
| `jdtls-lsp` | Java |
| `clangd-lsp` | C/C++ |
| `kotlin-lsp` | Kotlin |
| `ruby-lsp` | Ruby |
| `php-lsp` | PHP |
| `lua-lsp` | Lua |
| `swift-lsp` | Swift |
| `csharp-lsp` | C# |

Enable: `claude plugin enable typescript-lsp`

### Adding a Custom Marketplace

```json
// In ~/.claude/settings.json
{
  "extraKnownMarketplaces": {
    "my-marketplace": {
      "source": {
        "source": "github",
        "repo": "owner/repo-name"
      }
    }
  }
}
```

---

## Skills

Skills are reusable prompt templates invoked with `/skill-name`. Stored in `~/.claude/skills/`.

### Custom Skills

| Skill | What it does |
|-------|-------------|
| `/brainstorming` | Explore requirements and design before implementation |
| `/writing-plans` | Create multi-step implementation plans |
| `/executing-plans` | Execute plans with review checkpoints |
| `/test-driven-development` | TDD workflow — tests before implementation |
| `/systematic-debugging` | Scientific method debugging |
| `/ui-ux-pro-max` | UI/UX design with 50 styles, palettes, font pairings |
| `/uncodixify` | Anti-AI-aesthetic UI rules (avoid generic look) |
| `/feature-addition` | Implement features from Notion PRDs |
| `/remotion-video` | Generate programmatic videos with Remotion |
| `/verification-before-completion` | Verify work before claiming done |
| `/requesting-code-review` | Request structured code review |
| `/receiving-code-review` | Handle code review feedback properly |
| `/finishing-a-development-branch` | Guide branch completion (merge/PR/cleanup) |
| `/using-git-worktrees` | Isolated git worktrees for feature work |
| `/dispatching-parallel-agents` | Run independent tasks in parallel |
| `/subagent-driven-development` | Execute plans with subagents |
| `/writing-skills` | Create and test new skills |
| `/claude-api` | Build apps with Claude API / Anthropic SDK |

### Paperclip Skills (Symlinked)

| Skill | What it does |
|-------|-------------|
| `/paperclip` | Interact with Paperclip control plane API |
| `/paperclip-create-agent` | Create new agents with governance |
| `/create-agent-adapter` | Build new Paperclip agent adapters |
| `/para-memory-files` | PARA method file-based memory system |
| `/pr-report` | Deep PR analysis and maintainer reports |
| `/release` | Coordinate full release across systems |
| `/release-changelog` | Generate release changelogs |

### GSD (Get Stuff Done) Skills

| Skill | What it does |
|-------|-------------|
| `/gsd:new-project` | Initialize project with deep context gathering |
| `/gsd:plan-phase` | Create detailed phase plans |
| `/gsd:execute-phase` | Execute plans with wave-based parallelization |
| `/gsd:progress` | Check project progress |
| `/gsd:debug` | Systematic debugging with persistent state |
| `/gsd:verify-work` | Validate features through conversational UAT |
| `/gsd:resume-work` | Resume from previous session |
| `/gsd:quick` | Quick task with atomic commits |
| `/gsd:map-codebase` | Analyze codebase with parallel agents |
| `/gsd:health` | Diagnose planning directory health |

### Creating a Custom Skill

```bash
mkdir -p ~/.claude/skills/my-skill
cat > ~/.claude/skills/my-skill/skill.md << 'EOF'
---
name: my-skill
description: What this skill does
user_invocable: true
---

Your skill prompt instructions here...
EOF
```

---

## Hooks

Hooks run shell commands on Claude Code events. Configured in `~/.claude/settings.json`.

### Configured Hooks

| Event | Hook | What it does |
|-------|------|-------------|
| `SessionStart` | `gsd-check-update.js` | Check for GSD updates on session start |
| `PostToolUse` | `gsd-context-monitor.js` | Monitor context usage, warn when low |

### Status Line

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/hooks/gsd-statusline.js"
  }
}
```

Shows: model | current task | directory | context usage with progress bar.

---

## Permissions Configuration

### Full Permissions (for autonomous operation)

Add to `~/.claude/settings.json`:
```json
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Glob(*)",
      "Grep(*)",
      "Agent(*)",
      "WebFetch(*)",
      "WebSearch(*)",
      "NotebookEdit",
      "mcp__github__*",
      "mcp__claude_ai_Slack__*",
      "mcp__claude_ai_Linear__*",
      "mcp__jira__*",
      "mcp__notion__*",
      "mcp__postgres__*",
      "mcp__whatsapp__*",
      "mcp__browser-agent__*",
      "mcp__s3-upload__*"
    ]
  }
}
```

### Enable Agent Teams

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

---

## Quick Setup for New Server

Run these on a fresh server to replicate the full setup:

```bash
# 1. Install Claude Code
npm install -g @anthropic-ai/claude-code

# 2. Authenticate
claude auth login

# 3. Create settings
mkdir -p ~/.claude
cat > ~/.claude/settings.json << 'SETTINGS'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Glob(*)",
      "Grep(*)",
      "Agent(*)",
      "WebFetch(*)",
      "WebSearch(*)",
      "mcp__github__*",
      "mcp__claude_ai_Slack__*",
      "mcp__claude_ai_Linear__*",
      "mcp__jira__*",
      "mcp__notion__*",
      "mcp__postgres__*",
      "mcp__whatsapp__*",
      "mcp__browser-agent__*",
      "mcp__s3-upload__*"
    ]
  }
}
SETTINGS

# 4. Authenticate MCP servers (built-in ones)
claude mcp auth slack
claude mcp auth linear
claude mcp auth jira
claude mcp auth notion

# 5. Install plugins (optional)
claude plugin enable code-review
claude plugin enable typescript-lsp
```
