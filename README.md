# 🤖 AutoFix AI — Autonomous DevOps Incident Response Agent

> A multi-agent AI system that automatically detects errors, searches the web for solutions, validates fixes, and notifies the team — in under 2 minutes vs 45+ minutes manually.

---

## 🏗️ Project Structure

```
autofix-ai/                 ← root (you are here)
├── package.json            ← runs both servers with concurrently
├── .gitignore
│
├── backend/                ← Node.js Express server (port 3001)
│   ├── package.json
│   ├── index.js            ← secure API proxy (holds your API key)
│   ├── .env.example        ← template — copy this to .env
│   └── .env                ← YOUR API KEY (never commit this)
│
└── frontend/               ← React app (port 3000)
    ├── package.json
    ├── public/
    │   └── index.html
    └── src/
        ├── index.js        ← React entry point
        ├── index.css       ← Global styles
        └── App.jsx         ← Complete 6-agent UI
```

---

## ⚡ SETUP — Step by Step

### Step 1 — Make sure you have Node.js 18+

```bash
node --version
# should print v18.x.x or higher
```

If not installed: download from https://nodejs.org/

---

### Step 2 — Install all dependencies

From the **root** folder (`autofix-ai/`), run:

```bash
npm run setup
```

This installs packages for root + backend + frontend automatically.

---

### Step 3 — Add your Anthropic API key

```bash
# Create the .env file from the template
cp backend/.env.example backend/.env
```

Now open `backend/.env` in any text editor and replace the placeholder:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

with your real key from: https://console.anthropic.com/

---

### Step 4 — Run the project

```bash
npm start
```

This starts BOTH servers at the same time:
- **Backend**: http://localhost:3001 (the secure API proxy)
- **Frontend**: http://localhost:3000 (opens automatically in your browser)

---

## 🧠 How It Works

```
You paste error → 6 AI agents work autonomously:

1. 🧠 Manager Agent      — reads error, creates investigation plan (JSON)
2. 🌐 Researcher Agent   — live web searches (StackOverflow, GitHub, docs)
3. 📊 Analyst Agent      — filters research, picks the best fix
4. ✅ Tester Agent       — validates: "will this actually fix it?"
         ↑                  if REJECTED → self-correction loop ↓
         └──────────────── Researcher re-searches with refined queries
5. ✍️  Writer Agent      — professional incident report
6. ⚡ Action Agent       — Slack message + GitHub PR description
```

### Self-Correction Loop (the key feature)
If the Tester rejects a solution, the system automatically:
1. Gets the "retry_focus" from the Tester's feedback
2. Re-runs the Researcher with that specific focus
3. Re-runs the Analyst with fresh research
4. Re-validates with the Tester
5. Repeats up to 2 times before accepting best-effort result

---

## 🔒 Security Architecture

```
Browser (port 3000)
       │
       │  POST /api/chat  (no API key)
       ▼
Backend (port 3001)  ← API key lives HERE only
       │
       │  + x-api-key header added securely
       ▼
Anthropic API
```

Your API key is **never** sent to the browser. It stays in `backend/.env`.

---

## 🎯 Demo Flow (for judges)

1. Open http://localhost:3000
2. Select a sample error from the dropdown (or paste your own)
3. Click **Run AutoFix AI**
4. Watch the pipeline:
   - Each agent lights up as it works
   - Activity log shows real-time decisions
   - Agent output cards appear as each completes
   - Self-correction triggers if solution is rejected
5. View final report: Root Cause, Fixed Code, Steps, Team Notifications

---

## 🏆 Hackathon Criteria Met

| Criterion | Implementation |
|-----------|---------------|
| **Perception** | Reads raw error logs, searches live web |
| **Reasoning** | Manager creates structured JSON plan; multi-step delegation |
| **Action** | Generates Slack message, GitHub PR, incident report |
| **Tool Use** | Real web search API (StackOverflow, GitHub, docs) |
| **Multi-Agent** | 6 specialized agents with distinct roles |
| **Self-Correction** | Tester rejection triggers Researcher+Analyst retry loop |
| **Impact** | 45–60 min debugging → under 2 minutes |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, inline CSS |
| Backend | Node.js 18+, Express, CORS |
| AI Model | Claude Sonnet (via Anthropic API) |
| Web Search | Anthropic Web Search Tool |
| Runner | concurrently (runs both servers) |

---

## ❓ Troubleshooting

**"API key not configured"**
→ Make sure `backend/.env` exists and has your real key (not the placeholder)

**Frontend shows blank page**
→ Check that both servers are running (you should see BACKEND and FRONTEND in terminal)

**"Module not found" errors**
→ Run `npm run setup` again from the root folder

**Port already in use**
→ Kill existing processes: `lsof -ti:3000 | xargs kill` / `lsof -ti:3001 | xargs kill`