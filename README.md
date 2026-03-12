# WhatsApp AI Engineer

A powerful, two-stage agentic coding assistant that lives in your WhatsApp messages.
Powered by **Gemini** (as the conversational and orchestration brain) and **Claude Code CLI** (as the execution engine).

The WhatsApp Engineer allows you to instruct a fully autonomous coding agent right from your phone. It supports long-running sessions, resuming tasks, real-time logging streamed back to your chats, and a web dashboard for deeper control.

---

## Features

- **WhatsApp Interface**: Start, pause, plan, and monitor coding tasks via standard WhatsApp messages.
- **Bi-Directional Sync**: Interact with the agent via WhatsApp or the built-in Web Dashboard.
- **Persistent Sessions**: Disconnect your phone at any time. Claude keeps working on your server in the background and notifies you upon completion or error.
- **Cost Tracking**: Tracks LLM API spending across both Gemini orchestration and Claude execution automatically.
- **Dynamic Knowledge Base Integration**: Automatically pulls documentation from a specified GitHub repository to give Claude domain knowledge about your codebase.

---

## Prerequisites

1. **Node.js** (v18 or higher)
2. **SQLite3**
3. **Claude Code CLI**: Installed globally (`npm install -g @anthropic-ai/claude-code`)
   - Please ensure Claude is authenticated on the server (`claude login`).
4. **API Keys**:
   - [Gemini API Key](https://aistudio.google.com/) (Required for orchestration)
   - [Anthropic API Key](https://console.anthropic.com/) (Required for Claude execution)

---

## Setup & Installation

**1. Clone the repository**
```bash
git clone https://github.com/vedantnadhe-creator/whatsapp-engineer.git
cd whatsapp-engineer
npm install
```

**2. Configure Environment Variables**
```bash
cp .env.example .env
```

**3. Run the interactive setup wizard** (recommended)
```bash
bash setup.sh
```

Or manually edit `.env` with your Gemini API key, allowed phone numbers, and paths.

**4. Start the service**
```bash
bash start.sh
```

**5. Scan the QR code** (first run only)
```bash
tail -f /tmp/wa-engineer.log
```

---

## Web Dashboard

The application runs a lightweight web dashboard on **port 18790** by default.

- Dashboard: `http://localhost:18790`
- Login: `http://localhost:18790/login.html`

---

## Architecture

```
WhatsApp (Baileys) → Gemini (orchestrator) → Claude Code CLI (executor)
                                 ↑
                          Web Dashboard
```

- **Gemini** classifies intent (new task, resume, status, etc.) and routes to Claude
- **Claude Code CLI** executes coding tasks with full tool access
- **SQLite** stores sessions, costs, and access control
- **Node-PTY** provides real-time streaming of Claude output
