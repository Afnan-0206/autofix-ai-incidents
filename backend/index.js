require("dotenv").config();
console.log("API KEY:", process.env.ANTHROPIC_API_KEY);
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

const API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors());
app.use(express.json());

// health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY
  });
});

// main API
app.post("/api/chat", async (req, res) => {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama3-70b-8192",
        messages: [
          { role: "user", content: JSON.stringify(req.body) }
        ],
      }),
    });

    const data = await response.json();

    const raw = data.choices?.[0]?.message?.content || "{}";

let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  parsed = {
    root_cause: "Parsing failed",
    solution_strategy: raw,
    fixed_code: "// Unable to parse code",
    why_this_fix: "Model did not return valid JSON"
  };
}

res.json({
  raw,
  parsed
});

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── Slack Webhook Route ───────────────────────────────────────
app.post("/api/slack", async (req, res) => {
  const { message } = req.body;
  if (!process.env.SLACK_WEBHOOK_URL) {
    return res.status(500).json({ error: "SLACK_WEBHOOK_URL not set in .env" });
  }
  try {
    const slackRes = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
  text: message || "🚀 AutoFix AI Notification",
      }),
    });
    if (!slackRes.ok) throw new Error(`Slack returned ${slackRes.status}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── GitHub Issue Route ────────────────────────────────────────
app.post("/api/github-issue", async (req, res) => {
  const { title, body } = req.body;

  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: "GITHUB_TOKEN not set" });
  }

  try {
    const ghRes = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/issues`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
          "Content-Type": "application/json",
          "Accept": "application/vnd.github+json",
        },
        body: JSON.stringify({
          title: `[AutoFix AI] ${title}`,
          body: body,
          labels: ["autofix-ai", "incident"],
        }),
      }
    );

    const data = await ghRes.json();

    res.json({
      success: true,
      issueUrl: data.html_url,
      issueNumber: data.number,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// start server
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});