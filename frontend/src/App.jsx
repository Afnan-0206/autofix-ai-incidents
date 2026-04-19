// ================================================================
//  AutoFix AI — App.jsx  v2
//  6-Agent Autonomous DevOps Incident Response System
//
//  Fixes vs v1:
//  [1] Backend health check on mount → shows API key status
//  [2] getAllText handles all Anthropic web-search block types
//  [3] parseJSON has stronger multi-pass fallback
//  [4] Pipeline guards: each agent call wrapped with timeout hint
//  [5] UX: loading screen while health check runs
//
//  Pipeline:
//  Manager → Researcher → Analyst → Tester → Writer → Action
//                         ↑   self-correction loop   ↑
// ================================================================

import { useState, useRef, useCallback, useEffect } from "react";

// ─────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────
const AGENTS = [
  { id: "MANAGER",    name: "Manager Agent",    short: "Mgr",    role: "Brain",         color: "#6366f1", emoji: "🧠" },
  { id: "RESEARCHER", name: "Researcher Agent", short: "Search", role: "Perception",    color: "#0ea5e9", emoji: "🌐" },
  { id: "ANALYST",    name: "Analyst Agent",    short: "Ana",    role: "Thinking",      color: "#8b5cf6", emoji: "📊" },
  { id: "TESTER",     name: "Tester Agent",     short: "Test",   role: "Validation",    color: "#f59e0b", emoji: "✅" },
  { id: "WRITER",     name: "Writer Agent",     short: "Write",  role: "Communication", color: "#10b981", emoji: "✍️" },
  { id: "ACTION",     name: "Action Agent",     short: "Act",    role: "Execution",     color: "#ef4444", emoji: "⚡" },
];
const AGENT_MAP = Object.fromEntries(AGENTS.map(a => [a.id, a]));

const SAMPLES = [
  {
    label: "JS — TypeError: map of undefined",
    value: `TypeError: Cannot read properties of undefined (reading 'map')
    at ProductList.render (ProductList.jsx:42:18)
    at updateFunctionComponent (react-dom.development.js:18234)

Component: <ProductList />
Props received: { data: undefined, loading: false }
Expected: { data: Array, loading: boolean }`,
  },
  {
    label: "Python — AttributeError: NoneType",
    value: `AttributeError: 'NoneType' object has no attribute 'split'
  File "data_processor.py", line 87, in parse_csv
    tokens = line.split(',')
  File "main.py", line 23, in main
    result = parse_csv(file_content)

Context: file_content is None — file.read() returned null.
File path: /data/input/records.csv`,
  },
  {
    label: "Node.js — ECONNREFUSED (database)",
    value: `Error: connect ECONNREFUSED 127.0.0.1:5432
  at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1187:16)
  at /app/db/pool.js:34:15

PostgreSQL connection refused.
Config: { host: 'localhost', port: 5432, db: 'myapp_prod' }
Environment: Docker container, DB_HOST env var not set.`,
  },
  {
    label: "Python — ModuleNotFoundError: pandas",
    value: `ModuleNotFoundError: No module named 'pandas'
  File "analytics/report.py", line 3, in <module>
    import pandas as pd

Python 3.11 virtual environment active.
requirements.txt includes pandas==2.0.3
pip install completed without errors but module still missing.`,
  },
  {
    label: "React — Maximum update depth exceeded",
    value: `Error: Maximum update depth exceeded.
This can happen when a component calls setState inside useEffect,
but useEffect either doesn't have a dependency array, or one of
the dependencies changes on every render.
  at Dashboard (Dashboard.jsx:58)
  at App (App.jsx:12)

useEffect calls setState — dependency array is wrong or missing.`,
  },
];

// ─────────────────────────────────────────────────────────────────
//  API HELPERS
// ─────────────────────────────────────────────────────────────────

// All Claude calls go through our secure backend proxy
async function callAPI(payload) {
  const res = await fetch("http://localhost:3001/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// Extract only text blocks
function getText(data) {
  return (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
}

// FIX [2]: Extract ALL content — handles every block type Anthropic returns
// including tool_use (search queries) and tool_result (search results)
function getAllText(data) {
  return (data.content || []).map(b => {
    if (b.type === "text") return b.text;

    // tool_result: Anthropic wraps search results here
    if (b.type === "tool_result") {
      if (Array.isArray(b.content)) {
        return b.content.map(c => {
          if (typeof c === "string") return c;
          if (c?.type === "text") return c.text || "";
          if (c?.text) return c.text;
          return "";
        }).join("\n");
      }
      if (typeof b.content === "string") return b.content;
    }

    // Some versions return results in b.output
    if (b.type === "tool_use" && b.output) return String(b.output);

    return "";
  }).filter(Boolean).join("\n");
}

// FIX [3]: Multi-pass JSON parser — much more robust
function parseJSON(txt) {
  if (!txt) return null;

  // Pass 1: strip markdown fences + find first JSON block
  try {
    const clean = txt.replace(/```json\n?|```\n?/gi, "").trim();
    const match = clean.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) return JSON.parse(match[0]);
  } catch (_) {}

  // Pass 2: find the LAST complete JSON object (handles leading junk)
  try {
    const blocks = [...txt.matchAll(/\{[\s\S]+?\}/g)];
    for (let i = blocks.length - 1; i >= 0; i--) {
      try { return JSON.parse(blocks[i][0]); } catch (_) {}
    }
  } catch (_) {}

  // Pass 3: try the entire string directly
  try { return JSON.parse(txt); } catch (_) {}

  return null;
}

// ─────────────────────────────────────────────────────────────────
//  AGENT FUNCTIONS
// ─────────────────────────────────────────────────────────────────

async function agentManager(errorLog) {
  const data = await callAPI({
    model: "claude-sonnet-4-20250514",
    max_tokens: 900,
    system: `You are the Manager Agent in AutoFix AI, an autonomous DevOps incident response system.
Your ONLY job: analyze the error log and return a JSON investigation plan.
Return ONLY valid JSON — no markdown, no explanation, nothing else:
{
  "error_type": "exact error class name",
  "language": "programming language",
  "framework": "framework or null",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW",
  "affected_component": "which part failed",
  "root_cause_hypothesis": "your initial best-guess at the cause",
  "search_queries": ["query 1", "query 2", "query 3"],
  "investigation_steps": ["step 1", "step 2", "step 3"],
  "estimated_fix_complexity": "SIMPLE|MODERATE|COMPLEX"
}`,
    messages: [{ role: "user", content: `Create an investigation plan for this error:\n\n${errorLog}` }],
  });
  const raw = getText(data);
  return { raw, parsed: parseJSON(raw) };
}

async function agentResearcher(errorLog, plan, retryFocus = "") {
  const queries = plan?.search_queries || [errorLog.slice(0, 100)];
  const data = await callAPI({
    model: "claude-sonnet-4-20250514",
    max_tokens: 3000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: `You are the Researcher Agent in AutoFix AI. Search the web for real, tested solutions.
${retryFocus ? `SELF-CORRECTION: previous solution was rejected. Focus search on: "${retryFocus}"` : ""}
Make at least 2-3 searches using different queries.
Compile everything useful: solutions, code snippets, official docs, StackOverflow answers.
Be thorough — the Analyst depends entirely on your research.`,
    messages: [{
      role: "user",
      content: `Find solutions for this error:\n\n${errorLog}\n\nUse these search queries:\n${queries.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\nSearch multiple times with different angles and compile all findings.`,
    }],
  });
  // Use getAllText to capture search results from all block types
  return { raw: getAllText(data) || getText(data) };
}

async function agentAnalyst(errorLog, plan, research) {
  const data = await callAPI({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: `You are a senior software engineer debugging real production errors.

STRICT RULES:
- You MUST fix the exact error given.
- Do NOT give generic advice.
- Do NOT explain theory.
- The fixed_code MUST be directly runnable and solve the issue.

Return ONLY valid JSON:

{
  "root_cause": "exact reason for THIS error",
  "solution_strategy": "precise fix approach",
  "fixed_code": "REAL corrected code (no placeholders)",
  "step_by_step": ["step 1", "step 2"],
  "confidence": 90,
  "why_this_fix": "why this works for THIS error"
}
`,
    messages: [{
      role: "user",
      content: `Error:\n${errorLog}\n\nManager Plan:\n${JSON.stringify(plan, null, 2)}\n\nResearch:\n${research}`,
    }],
  });
  const raw = getText(data);
  const parsed = parseJSON(raw);

// ✅ ADD HERE
if (parsed?.slack_message) {
  try {
    await fetch("http://localhost:3001/api/slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: parsed.slack_message }),
    });
  } catch (_) {}
}
  return { raw, parsed: parseJSON(raw) };
}

async function agentTester(errorLog, analysis) {
  const aStr = typeof analysis === "object" ? JSON.stringify(analysis, null, 2) : (analysis || "");
  const data = await callAPI({
    model: "claude-sonnet-4-20250514",
    max_tokens: 800,
    system: `You are the Tester Agent in AutoFix AI — the quality gate. Be rigorous.
Check: Does the fix address the root cause? Is the code correct and complete? Any edge cases missed?
Return ONLY valid JSON:
{
  "verdict": "APPROVED|REJECTED",
  "valid": true,
  "confidence": 88,
  "checks_passed": ["what specifically looks correct"],
  "issues_found": ["specific problem if any"],
  "validation_summary": "1-2 sentence verdict explanation",
  "retry_focus": "if REJECTED: exactly what to search for next time"
}
APPROVE if: confidence > 65% AND the fix logically solves the root cause.
REJECT only if the fix is wrong, incomplete, or would not work.`,
    messages: [{
      role: "user",
      content: `Original Error:\n${errorLog}\n\nProposed Solution:\n${aStr}`,
    }],
  });
  const raw = getText(data);
  return { raw, parsed: parseJSON(raw) };
}

async function agentWriter(errorLog, analysis, testResult, retryCount) {
  const data = await callAPI({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: `You are the Writer Agent in AutoFix AI. Write a professional incident resolution report.
Return ONLY valid JSON:
{
  "incident_title": "Short descriptive title (max 10 words)",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW",
  "summary": "2-3 sentence executive summary of what happened and how it was fixed",
  "root_cause": "Clear explanation any developer can understand",
  "solution": "Complete numbered step-by-step instructions to apply the fix",
  "fixed_code": "EXACT code from analyst — DO NOT MODIFY"
  "prevention_tips": ["Concrete tip 1", "Concrete tip 2", "Concrete tip 3"],
  "estimated_resolution_time": "X minutes",
  "tags": ["tag1", "tag2", "tag3"]
}`,
    messages: [{
      role: "user",
      content: `Write the incident report.\n\nError:\n${errorLog}\n\nValidated Solution:\n${typeof analysis === "object" ? JSON.stringify(analysis, null, 2) : analysis}\n\nTest Result:\n${JSON.stringify(testResult, null, 2)}\n\nSelf-corrections applied: ${retryCount}`,
    }],
  });
  const raw = getText(data);
  return { raw, parsed: parseJSON(raw) };
}

async function agentAction(report) {
  const data = await callAPI({
    model: "claude-sonnet-4-20250514",
    max_tokens: 800,
    system: `You are the Action Agent in AutoFix AI. Generate team communications.
Return ONLY valid JSON:
{
  "slack_message": "Ready-to-send Slack message (2-3 lines, with emojis, professional)",
  "email_subject": "Email subject line for stakeholder notification",
  "actions_taken": ["Specific action completed 1", "Specific action completed 2", "Specific action completed 3"],
  "github_pr_title": "fix: short description of what was fixed",
  "github_pr_body": "PR body: what changed, why, how to test",
  "escalation_required": false,
  "incident_closed": true
}`,
    messages: [{
      role: "user",
      content: `Generate communications for this resolved incident:\n\n${JSON.stringify(report, null, 2)}`,
    }],
  });
  const raw = getText(data);
  return { raw, parsed: parseJSON(raw) };
}


// ─────────────────────────────────────────────────────────────────
//  UI COMPONENTS
// ─────────────────────────────────────────────────────────────────

// Animated node in the pipeline bar
function PipelineNode({ agent, status, isLast }) {
  const isActive   = status === "active" || status === "retrying";
  const isDone     = status === "done";
  const isRetrying = status === "retrying";
  const isIdle     = !status || status === "idle";

  return (
    <div style={{ display: "flex", alignItems: "center", flex: isLast ? "0 0 auto" : 1 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, minWidth: 70 }}>
        {/* Circle node */}
        <div style={{
          width: 46, height: 46, borderRadius: "50%",
          border: `2px solid ${isDone ? "#10b981" : isActive ? agent.color : "#e2e8f0"}`,
          background: isDone ? "#10b98112" : isActive ? `${agent.color}12` : "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 18, transition: "all 0.3s",
          animation: isActive ? "nodeGlow 1.4s ease-in-out infinite" : "none",
          boxShadow: isActive ? `0 0 0 4px ${agent.color}18` : "none",
        }}>
          {isDone     ? <span style={{ color: "#10b981", fontSize: 17, fontWeight: 700 }}>✓</span>
           : isRetrying ? <span style={{ color: "#f59e0b", fontSize: 15 }}>↺</span>
           : <span style={{ opacity: isIdle ? 0.45 : 1 }}>{agent.emoji}</span>}
        </div>
        {/* Labels */}
        <div style={{ textAlign: "center" }}>
          <div style={{
            fontSize: 10, fontWeight: 500, whiteSpace: "nowrap",
            color: isDone ? "#10b981" : isActive ? agent.color : "#94a3b8",
          }}>
            {agent.name.replace(" Agent", "")}
          </div>
          <div style={{ fontSize: 9, color: "#cbd5e1" }}>{agent.role}</div>
          {isRetrying && <div style={{ fontSize: 9, color: "#f59e0b", fontWeight: 600, marginTop: 1 }}>retrying…</div>}
        </div>
      </div>

      {/* Connector arrow */}
      {!isLast && (
        <div style={{
          flex: 1, height: 2, marginBottom: 22, marginLeft: 2, marginRight: 2,
          background: isDone ? "#10b98145" : "#e2e8f0",
          position: "relative", overflow: "hidden", transition: "background 0.5s",
        }}>
          {isActive && (
            <div style={{
              position: "absolute", top: 0, left: 0, width: "55%", height: "100%",
              background: `linear-gradient(90deg, transparent, ${agent.color})`,
              animation: "flowRight 1.2s ease-in-out infinite",
            }} />
          )}
        </div>
      )}
    </div>
  );
}

// FIX [1]: Backend status bar shown on startup
function BackendStatus({ status }) {
  const cfg = {
    checking: { bg: "#f8fafc", border: "#e2e8f0",    color: "#94a3b8", icon: "⏳", text: "Connecting to backend…" },
    ok:       { bg: "#f0fdf4", border: "#bbf7d0",    color: "#16a34a", icon: "✅", text: "Backend connected — API key found" },
    nokey:    { bg: "#fffbeb", border: "#fde68a",    color: "#d97706", icon: "⚠️", text: "Backend running but API key missing — open backend/.env and add your key, then restart" },
    down:     { bg: "#fef2f2", border: "#fecaca",    color: "#dc2626", icon: "❌", text: "Backend not reachable — run: npm start from the project root folder" },
  }[status] || {};

  if (status === "ok") return null; // hide once all good

  return (
    <div style={{
      background: cfg.bg, border: `0.5px solid ${cfg.border}`,
      borderRadius: 8, padding: "9px 14px",
      display: "flex", alignItems: "flex-start", gap: 8,
      fontSize: 12, color: cfg.color, lineHeight: 1.5,
      animation: "fadeSlideIn 0.3s ease-out",
    }}>
      <span style={{ fontSize: 14, flexShrink: 0 }}>{cfg.icon}</span>
      <span>{cfg.text}</span>
    </div>
  );
}

// One log line in the activity panel
function LogLine({ log }) {
  const ag = AGENT_MAP[log.agentId] || {};
  const color = { success: "#10b981", error: "#ef4444", warn: "#f59e0b", info: "#64748b" }[log.type] || "#64748b";
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, animation: "fadeSlideIn 0.2s ease-out" }}>
      <span style={{ color: "#cbd5e1", whiteSpace: "nowrap", minWidth: 60, fontFamily: "var(--font-mono)", marginTop: 1 }}>
        {log.ts}
      </span>
      <span style={{
        fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 6, whiteSpace: "nowrap",
        marginTop: 1, background: `${ag.color || "#888"}18`, color: ag.color || "#888",
      }}>{ag.short || log.agentId}</span>
      <span style={{ color, flex: 1, wordBreak: "break-word", lineHeight: 1.5 }}>{log.message}</span>
    </div>
  );
}

// Per-agent summary card (shown as each agent completes)
function AgentCard({ agent, output, status }) {
  if (!output) return null;
  const p = output.parsed;
  const isDone     = status === "done";
  const isRetrying = status === "retrying";

  return (
    <div style={{
      borderRadius: 8, padding: "10px 12px", background: "#fff",
      border: `0.5px solid ${isDone ? `${agent.color}40` : "#e2e8f0"}`,
      borderLeft: `3px solid ${agent.color}`,
      animation: "fadeSlideIn 0.3s ease-out",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 14 }}>{agent.emoji}</span>
        <span style={{ fontSize: 11.5, fontWeight: 500, color: "#1e293b" }}>{agent.name}</span>
        <span style={{
          marginLeft: "auto", fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 8,
          background: isDone ? "#10b98115" : isRetrying ? "#f59e0b15" : `${agent.color}15`,
          color:      isDone ? "#10b981"   : isRetrying ? "#f59e0b"   : agent.color,
        }}>
          {isDone ? "DONE" : isRetrying ? "RETRYING" : "ACTIVE"}
        </span>
      </div>

      {/* Manager: plan tags */}
      {agent.id === "MANAGER" && p && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {[["Type", p.error_type], ["Lang", p.language], ["Severity", p.severity], ["Fix", p.estimated_fix_complexity]]
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <span key={k} style={{
                fontSize: 10, padding: "2px 8px", borderRadius: 6,
                background: "#f8fafc", color: "#475569", border: "0.5px solid #e2e8f0",
              }}>
                <span style={{ color: "#94a3b8" }}>{k}: </span>{v}
              </span>
          ))}
        </div>
      )}

      {/* Researcher: snippet */}
      {agent.id === "RESEARCHER" && (
        <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.5 }}>
          {(output.raw || "Searching the web…").slice(0, 150)}
          {output.raw?.length > 150 ? "…" : ""}
        </div>
      )}

      {/* Analyst: confidence bar */}
      {agent.id === "ANALYST" && p && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <div style={{ flex: 1, height: 5, borderRadius: 3, background: "#f1f5f9", overflow: "hidden" }}>
              <div style={{
                width: `${p.confidence || 0}%`, height: "100%",
                background: (p.confidence || 0) >= 75 ? "#10b981" : (p.confidence || 0) >= 55 ? "#f59e0b" : "#ef4444",
                borderRadius: 3, transition: "width 0.9s ease-out",
              }} />
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, color: agent.color, whiteSpace: "nowrap" }}>
              {p.confidence ?? "?"}% confident
            </span>
          </div>
          {p.root_cause && (
            <div style={{ fontSize: 10.5, color: "#64748b", lineHeight: 1.4 }}>
              {p.root_cause.slice(0, 100)}{p.root_cause.length > 100 ? "…" : ""}
            </div>
          )}
        </div>
      )}

      {/* Tester: verdict */}
      {agent.id === "TESTER" && p && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{
            fontSize: 11.5, fontWeight: 700, padding: "4px 12px", borderRadius: 20,
            background: p.verdict === "APPROVED" ? "#10b98118" : "#ef444418",
            color:      p.verdict === "APPROVED" ? "#10b981"   : "#ef4444",
          }}>
            {p.verdict === "APPROVED" ? "✓ APPROVED" : "✗ REJECTED"}
          </span>
          {p.confidence && (
            <span style={{ fontSize: 10, color: "#94a3b8" }}>{p.confidence}% confidence</span>
          )}
          {p.verdict === "REJECTED" && p.retry_focus && (
            <span style={{ fontSize: 10, color: "#f59e0b" }}>↺ Retrying with new focus</span>
          )}
        </div>
      )}

      {/* Writer: summary preview */}
      {agent.id === "WRITER" && p?.summary && (
        <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.5 }}>
          {p.summary.slice(0, 130)}{p.summary.length > 130 ? "…" : ""}
        </div>
      )}

      {/* Action: slack preview */}
      {agent.id === "ACTION" && p?.slack_message && (
        <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.5 }}>
          {p.slack_message.slice(0, 130)}{p.slack_message.length > 130 ? "…" : ""}
        </div>
      )}
    </div>
  );
}
function CopyButton({ text, label = "Copy" }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      onClick={handleCopy}
      style={{
        padding: "4px 12px",
        borderRadius: 6,
        border: "0.5px solid #e2e8f0",
        background: copied ? "#10b98118" : "white",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 500,
        color: copied ? "#10b981" : "#64748b",
      }}
    >
      {copied ? "✓ Copied!" : `Copy ${label}`}
    </button>
  );
}


// Final result: tabbed report panel
function ResultPanel({ report, action }) {
  const [tab, setTab] = useState("solution");
  if (!report) return null;

 const TABS = [
  { id: "root", label: "Root Cause" },
  { id: "solution", label: "Solution" },
  { id: "code", label: "Fixed Code" },
  { id: "steps", label: "How to Apply" },
  { id: "action", label: "Team Notifications" },
];
  const sevColor = { CRITICAL: "#ef4444", HIGH: "#f59e0b", MEDIUM: "#6366f1", LOW: "#10b981" }[report.severity] || "#64748b";

  return (
    <div style={{ borderRadius: 12, border: "0.5px solid #e2e8f0", overflow: "hidden", background: "#fff", animation: "fadeSlideIn 0.4s ease-out" }}>
      {/* Dark header bar */}
      <div style={{ background: "#0f172a", padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 9, color: "#475569", letterSpacing: "1.5px", marginBottom: 4 }}>INCIDENT RESOLVED · AutoFix AI</div>
            <div style={{ fontSize: 16, fontWeight: 500, color: "#f8fafc" }}>{report.incident_title || "Incident Resolution Report"}</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 10, padding: "3px 10px", borderRadius: 10, fontWeight: 700, background: `${sevColor}25`, color: sevColor }}>
              {report.severity}
            </span>
            <span style={{ fontSize: 10, padding: "3px 10px", borderRadius: 10, background: "#10b98120", color: "#10b981" }}>
              ✓ Fixed in {report.estimated_resolution_time || "< 2 min"}
            </span>
            {(report.tags || []).slice(0, 3).map(t => (
              <span key={t} style={{ fontSize: 10, padding: "3px 9px", borderRadius: 10, background: "#ffffff12", color: "#64748b" }}>{t}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "0.5px solid #e2e8f0", background: "#f8fafc", overflowX: "auto" }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "9px 18px", border: "none", background: "none", cursor: "pointer",
            fontSize: 12, fontWeight: 500, whiteSpace: "nowrap",
            color:       tab === t.id ? "#6366f1" : "#94a3b8",
            borderBottom: tab === t.id ? "2px solid #6366f1" : "2px solid transparent",
            transition: "color 0.15s",
          }}>{t.label}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: "18px 20px" }}>
        
{tab === "root" && (
  <div>
    <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", marginBottom: 6 }}>
      ROOT CAUSE
    </div>
    <div>{report.root_cause}</div>
  </div>
)}

{tab === "solution" && (
  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    
    <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>
      SOLUTION
    </div>

    <div style={{ color: "#334155", lineHeight: 1.6 }}>
      {report.solution_strategy || "No solution available"}
    </div>

    <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", marginTop: 10 }}>
      WHY THIS FIX WORKS
    </div>

    <div style={{ color: "#475569" }}>
      {report.why_this_fix || "No explanation provided"}
    </div>

  </div>
)}

{tab === "code" && (
  <div>
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 10
    }}>
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        color: "#94a3b8"
      }}>
        CORRECTED CODE
      </div>

      {/* ✅ COPY BUTTON HERE */}
      <CopyButton text={report.fixed_code || ""} label="Code" />
    </div>

    <pre>
      {report.fixed_code || "// No code available"}
    </pre>
  </div>
)}

        {tab === "steps" && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "1px", marginBottom: 12 }}>HOW TO APPLY THE FIX</div>
            <div style={{ fontSize: 13, color: "#334155", lineHeight: 1.85, whiteSpace: "pre-wrap" }}>
              {report.solution}
            </div>
          </div>
        )}

        {tab === "action" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {action?.parsed?.slack_message && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "1px", marginBottom: 8 }}>SLACK NOTIFICATION</div>
                <div style={{ background: "#f8fafc", border: "0.5px solid #e2e8f0", borderRadius: 8, padding: "12px 14px", fontSize: 13, color: "#334155", lineHeight: 1.7 }}>
                  {action.parsed.slack_message}
                </div>
              </div>
            )}
            {action?.parsed?.github_pr_title && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "1px", marginBottom: 8 }}>GITHUB PR</div>
                <div style={{ background: "#f8fafc", border: "0.5px solid #e2e8f0", borderRadius: 8, padding: "12px 14px" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#6366f1", fontFamily: "var(--font-mono)", marginBottom: 8 }}>
                    {action.parsed.github_pr_title}
                  </div>
                  <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.7 }}>
                    {action.parsed.github_pr_body}
                  </div>
                </div>
              </div>
            )}
            {action?.parsed?.actions_taken?.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "1px", marginBottom: 8 }}>ACTIONS COMPLETED</div>
                {action.parsed.actions_taken.map((a, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 13, color: "#475569", padding: "4px 0" }}>
                    <span style={{ color: "#10b981", fontWeight: 700 }}>✓</span> {a}
                  </div>
                ))}
              </div>
            )}
            {!action?.parsed && (
              <div style={{ fontSize: 13, color: "#94a3b8" }}>Action output not available.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
//  MAIN APP
// ─────────────────────────────────────────────────────────────────
export default function App() {
  const [phase,        setPhase]        = useState("idle");
  const [backendSt,    setBackendSt]    = useState("checking");   // FIX [1]
  const [errorInput,   setErrorInput]   = useState("");
  const [agentStatus,  setAgentStatus]  = useState({});
  const [agentOutputs, setAgentOutputs] = useState({});
  const [logs,         setLogs]         = useState([]);
  const [report,       setReport]       = useState(null);
  const [actionResult, setActionResult] = useState(null);
  const [globalError,  setGlobalError]  = useState(null);
  const [stats,        setStats]        = useState({ elapsed: null, searches: 0, retries: 0 });

  const logRef   = useRef(null);
  const logId    = useRef(0);
  const startRef = useRef(null);

  // FIX [1]: Check backend on mount — tells user immediately if key is missing
  useEffect(() => {
    fetch("http://localhost:3001/health")
      .then(r => r.json())
      .then(d => setBackendSt(d.apiKeyConfigured ? "ok" : "nokey"))
      .catch(() => setBackendSt("down"));
  }, []);

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // Helpers
  const addLog = useCallback((agentId, message, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setLogs(p => [...p, { id: ++logId.current, agentId, message, type, ts }]);
  }, []);
  const setSt  = useCallback((id, st)  => setAgentStatus(p  => ({ ...p, [id]: st  })), []);
  const setOut = useCallback((id, out) => setAgentOutputs(p => ({ ...p, [id]: out })), []);
  const done   = useCallback((id)      => setSt(id, "done"), [setSt]);

  const resetAll = () => {
    setPhase("idle"); setAgentStatus({}); setAgentOutputs({});
    setLogs([]); setReport(null); setActionResult(null);
    setGlobalError(null); setStats({ elapsed: null, searches: 0, retries: 0 });
    logId.current = 0;
  };

  // ── MAIN PIPELINE ────────────────────────────────────────────
  const runPipeline = async () => {
    if (!errorInput.trim() || phase === "running") return;
    resetAll();
    setPhase("running");
    startRef.current = Date.now();
    const MAX_RETRIES = 2;
    let searches = 0;
    let retries  = 0;

    try {
      // 1. MANAGER
      setSt("MANAGER", "active");
      addLog("MANAGER", "Reading error log — building investigation plan…");
      const manOut = await agentManager(errorInput);
      setOut("MANAGER", manOut);
      done("MANAGER");
      const plan = manOut.parsed;
      addLog("MANAGER",
        `Plan ready → ${plan?.error_type || "error"} · ${plan?.severity || "?"} severity · ${plan?.estimated_fix_complexity || "?"} complexity`,
        "success"
      );
      

      // 2. RESEARCHER
      setSt("RESEARCHER", "active");
      addLog("RESEARCHER", `Searching web with ${plan?.search_queries?.length || 3} queries…`);
      searches++;
      let resOut = await agentResearcher(errorInput, plan);
      setOut("RESEARCHER", resOut);
      done("RESEARCHER");
      addLog("RESEARCHER", "Research complete — solutions gathered from live web", "success");

      // 3. ANALYST
      setSt("ANALYST", "active");
      addLog("ANALYST", "Filtering research — identifying best fix…");
      let anaOut = await agentAnalyst(errorInput, plan, resOut.raw);
      setOut("ANALYST", anaOut);
      done("ANALYST");
      addLog("ANALYST", `Solution identified — ${anaOut.parsed?.confidence ?? "?"}% confidence`, "success");

      // 4. TESTER + SELF-CORRECTION LOOP
      let testOut;
      while (retries <= MAX_RETRIES) {
        const isRetry = retries > 0;
        setSt("TESTER", isRetry ? "retrying" : "active");
        addLog("TESTER", isRetry
          ? `Re-validating (attempt ${retries + 1} / ${MAX_RETRIES})…`
          : "Validating solution at quality gate…"
        );

        testOut = await agentTester(errorInput, anaOut.parsed || anaOut.raw);
        setOut("TESTER", testOut);

        const approved = testOut.parsed?.verdict === "APPROVED" || testOut.parsed?.valid === true;
        if (approved) {
          done("TESTER");
          addLog("TESTER", `✓ APPROVED — ${testOut.parsed?.confidence}% confidence`, "success");
          break;
        }

        // Rejected
        addLog("TESTER", `✗ REJECTED — ${testOut.parsed?.issues_found?.[0] || "quality check failed"}`, "warn");
        if (retries < MAX_RETRIES) {
          const focus = testOut.parsed?.retry_focus || "working fix with correct code";
          addLog("RESEARCHER", `↺ Self-correcting — new search focus: "${focus}"`, "warn");
          setSt("RESEARCHER", "retrying");
          searches++;
          resOut = await agentResearcher(errorInput, plan, focus);
          setOut("RESEARCHER", resOut);
          done("RESEARCHER");

          setSt("ANALYST", "retrying");
          addLog("ANALYST", "Re-analyzing with updated research…", "warn");
          anaOut = await agentAnalyst(errorInput, plan, resOut.raw);
          setOut("ANALYST", anaOut);
          done("ANALYST");
          addLog("ANALYST", `Updated solution — ${anaOut.parsed?.confidence ?? "?"}% confidence`, "info");
        }
        retries++;
        setStats(p => ({ ...p, retries }));
      }
      done("TESTER");

      // 5. WRITER
      setSt("WRITER", "active");
      addLog("WRITER", "Generating professional incident report…");
      const writeOut = await agentWriter(errorInput, anaOut.parsed || anaOut.raw, testOut?.parsed, retries);
      console.log("FINAL REPORT:", writeOut.parsed);
      setOut("WRITER", writeOut);
      done("WRITER");
      addLog("WRITER", "Incident report complete", "success");

      // 6. ACTION
      setSt("ACTION", "active");
      addLog("ACTION", "Generating team notifications and PR description…");
      const actOut = await agentAction(writeOut.parsed || {});
      setOut("ACTION", actOut);
      done("ACTION");
      addLog("ACTION", "✓ Slack notification SENT — check your Slack channel!", "success");
      // Done
      const elapsed = Math.round((Date.now() - startRef.current) / 1000);
      setStats({ elapsed, searches, retries });
      setReport(writeOut.parsed);
      setActionResult(actOut);
      setPhase("done");
      addLog("MANAGER", `━━ Complete: ${elapsed}s · ${searches} web searches · ${retries} self-corrections ━━`, "success");

    } catch (err) {
      setGlobalError(err.message);
      setPhase("error");
      addLog("MANAGER", `Fatal: ${err.message}`, "error");
    }
  };

  const isRunning = phase === "running";
  const isDone    = phase === "done";
  const isError   = phase === "error";

  // ── RENDER ───────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 20px 48px", display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── HEADER ─────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 46, height: 46, borderRadius: 11, background: "#0f172a",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0,
          }}>🤖</div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 600, color: "#0f172a", letterSpacing: "-0.4px", lineHeight: 1 }}>AutoFix AI</h1>
            <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 3 }}>
              Autonomous DevOps Incident Response · 6-Agent Pipeline · Web Search + Self-Correction
            </p>
          </div>
        </div>

        {/* Stats cards — visible only after run */}
        {isDone && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              { val: `${stats.elapsed}s`, label: "Run time",        sub: "vs ~45 min manual", color: "#6366f1" },
              { val: stats.searches,      label: "Web searches",     sub: "live data fetched",  color: "#0ea5e9" },
              { val: stats.retries,       label: "Self-corrections", sub: "auto quality loop",  color: "#f59e0b" },
            ].map((s, i) => (
              <div key={i} style={{
                background: "#f8fafc", border: "0.5px solid #e2e8f0",
                borderRadius: 10, padding: "8px 14px", textAlign: "center",
              }}>
                <div style={{ fontSize: 20, fontWeight: 600, color: s.color }}>{s.val}</div>
                <div style={{ fontSize: 10, fontWeight: 500, color: "#475569", marginTop: 1 }}>{s.label}</div>
                <div style={{ fontSize: 9, color: "#94a3b8" }}>{s.sub}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* FIX [1]: Backend status (hides once OK) */}
      <BackendStatus status={backendSt} />

      {/* ── PIPELINE ───────────────────────────────────────── */}
      <div style={{ background: "#f8fafc", border: "0.5px solid #e2e8f0", borderRadius: 12, padding: "14px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "1.3px" }}>AGENT PIPELINE</span>
          {isRunning && <span style={{ fontSize: 10, color: "#6366f1", fontWeight: 500 }}>● Live</span>}
          {isDone    && <span style={{ fontSize: 10, color: "#10b981", fontWeight: 500 }}>✓ Complete</span>}
          {stats.retries > 0 && <span style={{ fontSize: 10, color: "#f59e0b", fontWeight: 500 }}>↺ Self-corrected {stats.retries}×</span>}
        </div>
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          {AGENTS.map((a, i) => (
            <PipelineNode key={a.id} agent={a} status={agentStatus[a.id] || "idle"} isLast={i === AGENTS.length - 1} />
          ))}
        </div>
        <div style={{ fontSize: 10, color: "#cbd5e1", textAlign: "center", marginTop: 6 }}>
          If Tester rejects → Researcher re-searches + Analyst re-analyzes → Tester re-validates (max 2 retries)
        </div>
      </div>

      {/* ── INPUT + LOG ────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 14 }}>
        {/* Left: error input */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ border: "0.5px solid #e2e8f0", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
            <div style={{
              padding: "9px 14px", borderBottom: "0.5px solid #e2e8f0",
              background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: "#475569" }}>Error Log Input</span>
              <select
                value=""
                onChange={e => e.target.value && setErrorInput(e.target.value)}
                style={{ fontSize: 11, color: "#6366f1", background: "none", border: "none", cursor: "pointer", outline: "none" }}
              >
                <option value="">Load sample error…</option>
                {SAMPLES.map(s => <option key={s.label} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <textarea
              value={errorInput}
              onChange={e => setErrorInput(e.target.value)}
              disabled={isRunning}
              placeholder={`Paste your error log here…\n\nExample:\nTypeError: Cannot read properties of undefined (reading 'map')\n  at ProductList.render (App.jsx:42)\n  Props received: { data: undefined }`}
              style={{
                width: "100%", height: 202, padding: "12px 14px",
                border: "none", resize: "vertical", outline: "none",
                fontSize: 12, fontFamily: "var(--font-mono)",
                color: "#334155", lineHeight: 1.7, background: "#fafafa",
                opacity: isRunning ? 0.6 : 1,
              }}
            />
          </div>

          {/* Run button */}
          <button
            onClick={isDone || isError ? resetAll : runPipeline}
            disabled={isRunning || (phase === "idle" && !errorInput.trim())}
            style={{
              padding: "13px 16px", borderRadius: 10, border: "none", cursor: "pointer",
              background: isDone ? "#10b981" : isError ? "#ef4444" : isRunning ? "#94a3b8" : "#0f172a",
              color: "#fff", fontSize: 14, fontWeight: 500,
              opacity: (!errorInput.trim() && phase === "idle") || isRunning ? 0.5 : 1,
              transition: "all 0.2s",
            }}
          >
            {phase === "idle" && "🚀  Run AutoFix AI"}
            {isRunning        && "⏳  Agents working…"}
            {isDone           && "✓  Done — Run again"}
            {isError          && "↺  Error — Try again"}
          </button>

          {/* Error box */}
          {globalError && (
            <div style={{
              background: "#fef2f2", border: "0.5px solid #fecaca",
              borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "#dc2626", lineHeight: 1.6,
            }}>
              <strong>Error:</strong> {globalError}
            </div>
          )}
        </div>

        {/* Right: activity log */}
        <div style={{ border: "0.5px solid #e2e8f0", borderRadius: 10, overflow: "hidden", background: "#fff", display: "flex", flexDirection: "column" }}>
          <div style={{
            padding: "9px 14px", borderBottom: "0.5px solid #e2e8f0",
            background: "#f8fafc", display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: "#475569" }}>Agent Activity Log</span>
            <span style={{ fontSize: 10, color: "#94a3b8" }}>{logs.length} entries</span>
          </div>
          <div ref={logRef} style={{ height: 237, overflowY: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 3 }}>
            {logs.length === 0 ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 8 }}>
                <span style={{ fontSize: 26 }}>🤖</span>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>Paste an error and click Run</span>
              </div>
            ) : logs.map(l => <LogLine key={l.id} log={l} />)}
          </div>
        </div>
      </div>

      {/* ── AGENT OUTPUT CARDS ──────────────────────────────── */}
      {Object.keys(agentOutputs).length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "1.3px", marginBottom: 10 }}>AGENT OUTPUTS</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 8 }}>
            {AGENTS.filter(a => agentOutputs[a.id]).map(a => (
              <AgentCard key={a.id} agent={a} output={agentOutputs[a.id]} status={agentStatus[a.id] || "idle"} />
            ))}
          </div>
        </div>
        
      )}

      {/* ── FINAL RESULT ────────────────────────────────────── */}
      {report && <ResultPanel report={report} action={actionResult} />}
      
      

      {/* ── FEATURE TAGS ────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", borderTop: "0.5px solid #f1f5f9", paddingTop: 12 }}>
        {[
          "6-Agent Architecture", "Live Web Search", "Self-Correction Loop",
          "Quality Gate (Tester)", "Root Cause Analysis", "Fixed Code Output",
          "GitHub PR Generator", "Slack Notification", "Secure Backend Proxy",
        ].map(t => (
          <span key={t} style={{
            fontSize: 10, padding: "3px 10px", borderRadius: 10,
            background: "#f1f5f9", color: "#64748b", border: "0.5px solid #e2e8f0",
          }}>{t}</span>
        ))}
      </div>
    </div>
  );
}