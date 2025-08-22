// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:3001",
      "https://claude.ai",
    ],
    credentials: true,
  })
);
app.use(express.json());

// Utility: mask tokens in logs
const mask = (s = "") => {
  if (!s) return "";
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
};

// Normalize serverUrl input (allow "your.atlassian.net" or "https://your.atlassian.net")
function normalizeServerUrl(raw) {
  if (!raw) return null;
  let url = String(raw).trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  // remove trailing slash
  return url.replace(/\/+$/, "");
}

// Extract credentials (body > headers > query). NO env fallback.
function extractCredentials(req) {
  const serverRaw =
    req.body?.serverUrl || req.headers["x-jira-server"] || req.query.serverUrl;
  const username =
    req.body?.username || req.headers["x-jira-user"] || req.query.username;
  const apiToken =
    req.body?.apiToken || req.headers["x-jira-token"] || req.query.apiToken;

  const serverUrl = normalizeServerUrl(serverRaw);
  return { serverUrl, username, apiToken };
}

// Simple request logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "JIRA proxy server is running",
    timestamp: new Date().toISOString(),
  });
});

// Test connection (requires serverUrl, username, apiToken in body/headers/query)
app.post("/jira/test-connection", async (req, res) => {
  try {
    const { serverUrl, username, apiToken } = extractCredentials(req);

    if (!serverUrl || !username || !apiToken) {
      return res
        .status(400)
        .json({
          error: "Missing credentials",
          message: "Provide serverUrl, username and apiToken",
        });
    }

    const jiraUrl = `${serverUrl}/rest/api/3/myself`;
    console.log("🌐 Testing Jira connection:", jiraUrl);
    console.log("📧 Username:", username);
    console.log("🔑 Token:", mask(apiToken));

    const authHeader = `Basic ${Buffer.from(`${username}:${apiToken}`).toString(
      "base64"
    )}`;

    const response = await fetch(jiraUrl, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "User-Agent": "JIRA-Proxy-Server/1.0",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("❌ Jira test error:", response.status, text);
      return res
        .status(response.status)
        .json({
          error: text,
          status: response.status,
          statusText: response.statusText,
        });
    }

    const data = await response.json();
    return res.json({
      status: "ok",
      user: {
        accountId: data.accountId,
        displayName: data.displayName,
        emailAddress: data.emailAddress,
        active: data.active,
      },
      message: "Connection successful",
    });
  } catch (err) {
    console.error("❌ test-connection exception:", err);
    return res
      .status(500)
      .json({ error: String(err), message: "Failed to connect to JIRA" });
  }
});

// Get tasks (POST) - requires credentials in body/headers/query
app.post("/jira/get-tasks", async (req, res) => {
  try {
    const { serverUrl, username, apiToken } = extractCredentials(req);
    const jql =
      req.body?.jql ||
      "assignee = currentUser() AND status != Done ORDER BY updated DESC";

    if (!serverUrl || !username || !apiToken) {
      return res
        .status(400)
        .json({
          error: "Missing credentials",
          message: "Provide serverUrl, username and apiToken",
        });
    }

    const jiraUrl = `${serverUrl}/rest/api/3/search`;
    console.log("🔍 JQL:", jql);
    console.log("🌐 Searching:", jiraUrl);
    console.log("📧 Username:", username);
    console.log("🔑 Token:", mask(apiToken));

    const authHeader = `Basic ${Buffer.from(`${username}:${apiToken}`).toString(
      "base64"
    )}`;

    const response = await fetch(jiraUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "JIRA-Proxy-Server/1.0",
      },
      body: JSON.stringify({
        jql,
        maxResults: 100,
        fields: [
          "summary",
          "status",
          "assignee",
          "priority",
          "project",
          "issuetype",
          "timetracking",
          "created",
          "updated",
          "description",
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("❌ JIRA search error:", response.status, text);
      return res
        .status(response.status)
        .json({ error: text, status: response.status });
    }

    const data = await response.json();
    return res.json({
      issues: data.issues,
      total: data.total,
      maxResults: data.maxResults,
      startAt: data.startAt,
    });
  } catch (err) {
    console.error("❌ get-tasks exception:", err);
    return res
      .status(500)
      .json({ error: String(err), message: "Failed to fetch JIRA tasks" });
  }
});

// Get projects (POST)
app.post("/jira/get-projects", async (req, res) => {
  try {
    const { serverUrl, username, apiToken } = extractCredentials(req);

    if (!serverUrl || !username || !apiToken) {
      return res
        .status(400)
        .json({
          error: "Missing credentials",
          message: "Provide serverUrl, username and apiToken",
        });
    }

    const jiraUrl = `${serverUrl}/rest/api/3/project/search`;
    console.log("📂 Fetching projects:", jiraUrl);
    console.log("📧 Username:", username);
    console.log("🔑 Token:", mask(apiToken));

    const authHeader = `Basic ${Buffer.from(`${username}:${apiToken}`).toString(
      "base64"
    )}`;

    const response = await fetch(jiraUrl, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "User-Agent": "JIRA-Proxy-Server/1.0",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("❌ Projects fetch error:", response.status, text);
      return res
        .status(response.status)
        .json({ error: text, status: response.status });
    }

    const data = await response.json();
    const projects = (data.values || []).map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      projectTypeKey: p.projectTypeKey,
      simplified: p.simplified,
    }));

    return res.json({ projects });
  } catch (err) {
    console.error("❌ get-projects exception:", err);
    return res
      .status(500)
      .json({ error: String(err), message: "Failed to fetch JIRA projects" });
  }
});

// Generic proxy for arbitrary Jira endpoints.
// Client must send serverUrl, username, apiToken in body/headers/query.
// Example: POST http://localhost:3001/jira/rest/api/3/issue  with body { serverUrl, username, apiToken, ... }
app.all(/^\/jira\/.*/, async (req, res) => {
  try {
    const { serverUrl, username, apiToken } = extractCredentials(req);

    if (!serverUrl || !username || !apiToken) {
      return res.status(400).json({
        error: "Missing credentials",
        message: "Provide serverUrl, username and apiToken",
      });
    }

    // Build target URL by removing leading '/jira'
    const pathAfter = req.originalUrl.replace(/^\/jira/, "");
    const targetUrl = `${serverUrl}${pathAfter}`;

    console.log(`🌐 Proxying to: ${targetUrl}`);
    console.log("📧 Username:", username);
    console.log("🔑 Token:", mask(apiToken));

    const authHeader = `Basic ${Buffer.from(`${username}:${apiToken}`).toString(
      "base64"
    )}`;

    const forwardHeaders = {
      Authorization: authHeader,
      Accept: req.headers.accept || "application/json",
      "Content-Type": req.headers["content-type"] || "application/json",
      "User-Agent": "JIRA-Proxy-Server/1.0",
    };

    const body = ["GET", "HEAD"].includes(req.method)
      ? undefined
      : JSON.stringify(req.body || {});

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
    });

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      return res.status(response.status).json(data);
    } else {
      const text = await response.text();
      return res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("❌ Generic proxy error:", err);
    return res.status(500).json({
      error: String(err),
      message: "Failed to proxy request to JIRA",
    });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error("🚨 Unhandled error:", err);
  res
    .status(500)
    .json({ error: "Internal server error", message: String(err) });
});

app.listen(PORT, () => {
  console.log(`✅ JIRA proxy server running on http://localhost:${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});
