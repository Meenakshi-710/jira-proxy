// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(
  cors({
    origin: [
      "http://localhost:5173",     // Vite dev
      "http://localhost:3001",     // Local server
      "https://claude.ai",         // Any other web app
      "chrome-extension://didiikhicfjlggddnigelfbopcladhgn",
      "chrome-extension://inaemmingkjlakjfggfifmifihicpcei",
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

// Get HR JIRA credentials from environment variables
function getHRCredentials() {
  return {
    serverUrl: process.env.HR_JIRA_SERVER_URL,
    username: process.env.HR_JIRA_USERNAME,
    apiToken: process.env.HR_JIRA_API_TOKEN
  };
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

// Extract credentials with HR fallback for HR users
function extractCredentialsWithHRFallback(req, isHRUser = false) {
  const extracted = extractCredentials(req);
  
  // If HR user and no credentials provided, use HR credentials
  if (isHRUser && (!extracted.serverUrl || !extracted.username || !extracted.apiToken)) {
    const hrCredentials = getHRCredentials();
    return {
      serverUrl: extracted.serverUrl || hrCredentials.serverUrl,
      username: extracted.username || hrCredentials.username,
      apiToken: extracted.apiToken || hrCredentials.apiToken
    };
  }
  
  return extracted;
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

// Get tasks for HR users (POST) - uses HR credentials automatically
app.post("/jira/hr/get-tasks", async (req, res) => {
  try {
    // Get HR credentials from environment variables
    const hrCredentials = getHRCredentials();
    const { serverUrl, username, apiToken } = hrCredentials;
    
    const jql = req.body?.jql || "assignee = currentUser() AND status != Done ORDER BY updated DESC";

    if (!serverUrl || !username || !apiToken) {
      console.error("❌ HR credentials missing:", { serverUrl: !!serverUrl, username: !!username, apiToken: !!apiToken });
      return res
        .status(400)
        .json({
          error: "Missing HR credentials",
          message: "HR JIRA credentials not configured. Please set HR_JIRA_SERVER_URL, HR_JIRA_USERNAME, and HR_JIRA_API_TOKEN in environment variables.",
        });
    }

    const jiraUrl = `${serverUrl}/rest/api/3/search/jql`;
    console.log("🔍 HR JQL:", jql);
    console.log("🌐 HR Searching:", jiraUrl);
    console.log("📧 HR Username:", username);
    console.log("🔑 HR Token:", mask(apiToken));
    console.log("📋 Request body:", JSON.stringify(req.body, null, 2));

    const authHeader = `Basic ${Buffer.from(`${username}:${apiToken}`).toString(
      "base64"
    )}`;

    // Use GET method with JQL as query parameter (correct approach for /rest/api/3/search/jql)
    const queryParams = new URLSearchParams({
      jql: jql,
      maxResults: '100',
      fields: 'summary,status,assignee,priority,project,issuetype,timetracking,created,updated,description,worklog'
    });
    
    const jiraUrlWithParams = `${jiraUrl}?${queryParams.toString()}`;
    console.log("🌐 Final HR JIRA URL:", jiraUrlWithParams);

    const response = await fetch(jiraUrlWithParams, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "User-Agent": "JIRA-Proxy-Server/1.0",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("❌ HR JIRA search error:", response.status, text);
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
    console.error("❌ hr/get-tasks exception:", err);
    return res
      .status(500)
      .json({ error: String(err), message: "Failed to fetch JIRA tasks for HR" });
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

    const jiraUrl = `${serverUrl}/rest/api/3/search/jql`;
    console.log("🔍 JQL:", jql);
    console.log("🌐 Searching:", jiraUrl);
    console.log("📧 Username:", username);
    console.log("🔑 Token:", mask(apiToken));

    const authHeader = `Basic ${Buffer.from(`${username}:${apiToken}`).toString(
      "base64"
    )}`;

    // Use GET method with JQL as query parameter (correct approach for /rest/api/3/search/jql)
    const queryParams = new URLSearchParams({
      jql: jql,
      maxResults: '100',
      fields: 'summary,status,assignee,priority,project,issuetype,timetracking,created,updated,description,worklog'
    });
    
    const jiraUrlWithParams = `${jiraUrl}?${queryParams.toString()}`;
    console.log("🌐 Final JIRA URL:", jiraUrlWithParams);

    const response = await fetch(jiraUrlWithParams, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "User-Agent": "JIRA-Proxy-Server/1.0",
      },
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
      nextPageToken: data.nextPageToken,
    });
  } catch (err) {
    console.error("❌ get-tasks exception:", err);
    return res
      .status(500)
      .json({ error: String(err), message: "Failed to fetch JIRA tasks" });
  }
});

// Get projects for HR users (POST) - uses HR credentials automatically
app.post("/jira/hr/get-projects", async (req, res) => {
  try {
    // Get HR credentials from environment variables
    const hrCredentials = getHRCredentials();
    const { serverUrl, username, apiToken } = hrCredentials;

    if (!serverUrl || !username || !apiToken) {
      console.error("❌ HR credentials missing:", { serverUrl: !!serverUrl, username: !!username, apiToken: !!apiToken });
      return res
        .status(400)
        .json({
          error: "Missing HR credentials",
          message: "HR JIRA credentials not configured. Please set HR_JIRA_SERVER_URL, HR_JIRA_USERNAME, and HR_JIRA_API_TOKEN in environment variables.",
        });
    }

    const jiraUrl = `${serverUrl}/rest/api/3/project/search?maxResults=100&expand=description,lead,url,projectKeys`;
    console.log("📂 HR Fetching projects:", jiraUrl);
    console.log("📧 HR Username:", username);
    console.log("🔑 HR Token:", mask(apiToken));

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
      console.error("❌ HR Projects fetch error:", response.status, text);
      console.error("❌ Response headers:", Object.fromEntries(response.headers.entries()));
      return res
        .status(response.status)
        .json({ error: text, status: response.status });
    }

    const data = await response.json();
    console.log("📊 Raw HR JIRA projects response:", JSON.stringify(data, null, 2));
    
    const projects = (data.values || []).map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      projectTypeKey: p.projectTypeKey,
      simplified: p.simplified,
    }));

    console.log(`✅ Processed ${projects.length} HR JIRA projects`);
    return res.json({ projects });
  } catch (err) {
    console.error("❌ hr/get-projects exception:", err);
    return res
      .status(500)
      .json({ error: String(err), message: "Failed to fetch JIRA projects for HR" });
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

    const jiraUrl = `${serverUrl}/rest/api/3/project/search?maxResults=100&expand=description,lead,url,projectKeys`;
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
      console.error("❌ Response headers:", Object.fromEntries(response.headers.entries()));
      return res
        .status(response.status)
        .json({ error: text, status: response.status });
    }

    const data = await response.json();
    console.log("📊 Raw JIRA projects response:", JSON.stringify(data, null, 2));
    
    const projects = (data.values || []).map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      projectTypeKey: p.projectTypeKey,
      simplified: p.simplified,
    }));

    console.log(`✅ Processed ${projects.length} JIRA projects`);
    return res.json({ projects });
  } catch (err) {
    console.error("❌ get-projects exception:", err);
    return res
      .status(500)
      .json({ error: String(err), message: "Failed to fetch JIRA projects" });
  }
});

// Add worklog to Jira issue (POST)
app.post("/jira/add-worklog", async (req, res) => {
  try {
    const { serverUrl, username, apiToken, issueKey, timeSpent, comment } = req.body;

    if (!serverUrl || !username || !apiToken) {
      return res
        .status(400)
        .json({
          error: "Missing credentials",
          message: "Provide serverUrl, username and apiToken",
        });
    }

    if (!issueKey || !timeSpent) {
      return res
        .status(400)
        .json({
          error: "Missing required fields",
          message: "Provide issueKey and timeSpent",
        });
    }

    // Validate timeSpent format (should match Jira's expected format: Xd Xh Xm)
    const timeSpentRegex = /^(\d+[wdhm])?\s*(\d+[wdhm])?\s*(\d+[wdhm])?\s*(\d+[wdhm])?$/;
    if (!timeSpentRegex.test(timeSpent.trim())) {
      return res
        .status(400)
        .json({
          error: "Invalid time format",
          message: "Time format should be like: 2h 30m, 1d, 45m (w=week, d=day, h=hour, m=minute)",
        });
    }

    const jiraUrl = `${serverUrl}/rest/api/3/issue/${issueKey}/worklog`;
    console.log("⏰ Adding worklog:", jiraUrl);
    console.log("🔑 Issue Key:", issueKey);
    console.log("⏱️ Time Spent:", timeSpent);
    console.log("💬 Comment:", comment || "No comment");
    console.log("📧 Username:", username);
    console.log("🔑 Token:", mask(apiToken));

    const authHeader = `Basic ${Buffer.from(`${username}:${apiToken}`).toString(
      "base64"
    )}`;

    // Build the worklog payload according to Jira's API requirements
    const worklogPayload = {
      timeSpent: timeSpent
    };

    // Add comment if provided, using Jira's required Atlassian Document Format
    if (comment && comment.trim()) {
      worklogPayload.comment = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: comment.trim()
              }
            ]
          }
        ]
      };
    }

    console.log("📦 Worklog Payload:", JSON.stringify(worklogPayload, null, 2));

    const response = await fetch(jiraUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "JIRA-Proxy-Server/1.0",
      },
      body: JSON.stringify(worklogPayload),
    });

          if (!response.ok) {
        const text = await response.text();
        console.error("❌ Add worklog error:", response.status, text);
        
        // Try to parse the error response as JSON for better error handling
        let errorData;
        try {
          errorData = JSON.parse(text);
        } catch (e) {
          errorData = { error: text };
        }
        
        return res
          .status(response.status)
          .json({ 
            error: errorData.error || errorData.errorMessages || text, 
            status: response.status,
            details: errorData
          });
      }

    const data = await response.json();
    console.log("✅ Worklog added successfully:", data);
    return res.json({
      status: "ok",
      message: "Worklog added successfully",
      worklog: data,
    });
  } catch (err) {
    console.error("❌ add-worklog exception:", err);
    return res
      .status(500)
      .json({ error: String(err), message: "Failed to add worklog to JIRA" });
  }
});

// Get worklogs for Jira issue (POST)
app.post("/jira/get-worklogs", async (req, res) => {
  try {
    const { serverUrl, username, apiToken, issueKey } = req.body;

    if (!serverUrl || !username || !apiToken) {
      return res
        .status(400)
        .json({
          error: "Missing credentials",
          message: "Provide serverUrl, username and apiToken",
        });
    }

    if (!issueKey) {
      return res
        .status(400)
        .json({
          error: "Missing required fields",
          message: "Provide issueKey",
        });
    }

    const jiraUrl = `${serverUrl}/rest/api/3/issue/${issueKey}/worklog`;
    console.log("📋 Getting worklogs:", jiraUrl);
    console.log("🔑 Issue Key:", issueKey);
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
      console.error("❌ Get worklogs error:", response.status, text);
      return res
        .status(response.status)
        .json({ error: text, status: response.status });
    }

    const data = await response.json();
    console.log("✅ Worklogs retrieved successfully:", data);
    return res.json({
      status: "ok",
      message: "Worklogs retrieved successfully",
      worklogs: data.worklogs || [],
      total: data.total || 0,
    });
  } catch (err) {
    console.error("❌ get-worklogs exception:", err);
    return res
      .status(500)
      .json({ error: String(err), message: "Failed to get worklogs from JIRA" });
  }
});

// Generic proxy for arbitrary Jira endpoints.
// Client must send serverUrl, username, apiToken in body/headers/query.
// Example: POST http://localhost:3001/jira/rest/api/3/issue  with body { serverUrl, username, apiToken, ... }
// Note: This should be placed after all specific routes to avoid conflicts
app.all(/^\/jira\/rest\/api\/.*/, async (req, res) => {
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
