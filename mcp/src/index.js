import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = parseInt(process.env.PORT || "8081", 10);
const GATEWAY_URL = (process.env.GATEWAY_URL || "http://gateway:8080").replace(/\/$/, "");
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || "";
// Fail closed: no key + no explicit opt-out means refuse to start — the MCP
// endpoint must never be anonymous by accident.
const ALLOW_UNAUTHENTICATED = /^(1|true)$/i.test(process.env.ALLOW_UNAUTHENTICATED || "");
if (!GATEWAY_API_KEY && !ALLOW_UNAUTHENTICATED) {
  console.error(
    "refusing to start: GATEWAY_API_KEY is not set. Set a bearer key in .env, " +
    "or set ALLOW_UNAUTHENTICATED=true to explicitly run without auth."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Thin REST client over the gateway (the system's single REST interface)
// ---------------------------------------------------------------------------
async function api(method, path, body) {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(GATEWAY_API_KEY ? { Authorization: `Bearer ${GATEWAY_API_KEY}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

// ---------------------------------------------------------------------------
// MCP server — tools mirror every Firecrawl endpoint plus /interact
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer(
    { name: "firecrawl-extended", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  const formats = z
    .array(z.string())
    .optional()
    .describe('Output formats, e.g. ["markdown","html","links","screenshot","json"]');

  server.registerTool(
    "firecrawl_scrape",
    {
      title: "Scrape URL",
      description: "Scrape a single URL and return markdown, HTML, links, screenshot or structured JSON.",
      inputSchema: {
        url: z.string().url().describe("URL to scrape"),
        formats,
        onlyMainContent: z.boolean().optional(),
        waitFor: z.number().optional().describe("Extra wait in ms after page load"),
        timeout: z.number().optional(),
        jsonOptions: z.record(z.any()).optional().describe("LLM extraction options (prompt/schema) applied during scrape"),
        actions: z.array(z.record(z.any())).optional().describe("Browser actions to run before scraping (click/write/press/scroll/wait/screenshot)"),
      },
    },
    async ({ url, ...opts }) =>
      ok(await api("POST", "/v1/scrape", { url, ...stripUndefined(opts) }))
  );

  server.registerTool(
    "firecrawl_batch_scrape",
    {
      title: "Batch Scrape",
      description: "Start an asynchronous batch scrape of many URLs. Returns a job id.",
      inputSchema: {
        urls: z.array(z.string().url()).describe("URLs to scrape"),
        formats,
        options: z.record(z.any()).optional().describe("Additional scrape options"),
      },
    },
    async ({ urls, formats: fmts, options }) =>
      ok(await api("POST", "/v2/batch/scrape", { urls, formats: fmts, ...(options || {}) }))
  );

  server.registerTool(
    "firecrawl_batch_scrape_status",
    {
      title: "Batch Scrape Status",
      description: "Get the status/results of a batch scrape job.",
      inputSchema: { id: z.string().describe("Batch scrape job id") },
    },
    async ({ id }) => ok(await api("GET", `/v2/batch/scrape/${id}`))
  );

  server.registerTool(
    "firecrawl_crawl",
    {
      title: "Crawl Website",
      description: "Start an asynchronous crawl of a website. Returns a job id; poll with firecrawl_crawl_status.",
      inputSchema: {
        url: z.string().url().describe("Base URL to start crawling from"),
        limit: z.number().optional().describe("Max pages to crawl"),
        maxDepth: z.number().optional(),
        includePaths: z.array(z.string()).optional(),
        excludePaths: z.array(z.string()).optional(),
        allowBackwardLinks: z.boolean().optional(),
        scrapeOptions: z.record(z.any()).optional(),
        webhook: z.string().optional(),
      },
    },
    async ({ url, ...opts }) =>
      ok(await api("POST", "/v2/crawl", { url, ...stripUndefined(opts) }))
  );

  server.registerTool(
    "firecrawl_crawl_status",
    {
      title: "Crawl Status",
      description: "Get the status/results of a crawl job.",
      inputSchema: { id: z.string().describe("Crawl job id") },
    },
    async ({ id }) => ok(await api("GET", `/v2/crawl/${id}`))
  );

  server.registerTool(
    "firecrawl_crawl_cancel",
    {
      title: "Cancel Crawl",
      description: "Cancel a running crawl job.",
      inputSchema: { id: z.string().describe("Crawl job id") },
    },
    async ({ id }) => ok(await api("DELETE", `/v2/crawl/${id}`))
  );

  server.registerTool(
    "firecrawl_map",
    {
      title: "Map Website",
      description: "Fast discovery of URLs on a website (sitemap + links).",
      inputSchema: {
        url: z.string().url(),
        search: z.string().optional().describe("Filter URLs containing this term"),
        limit: z.number().optional(),
        includeSubdomains: z.boolean().optional(),
        sitemap: z.enum(["include", "skip", "only"]).optional(),
      },
    },
    async ({ url, ...opts }) =>
      ok(await api("POST", "/v2/map", { url, ...stripUndefined(opts) }))
  );

  server.registerTool(
    "firecrawl_search",
    {
      title: "Web Search",
      description: "Search the web (local SearXNG) and optionally scrape the result pages.",
      inputSchema: {
        query: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max results (default 5)"),
        tbs: z.string().optional().describe("Time filter, e.g. qdr:d, qdr:w"),
        location: z.string().optional(),
        scrapeOptions: z.record(z.any()).optional().describe("e.g. {formats:[\"markdown\"]} to scrape each result"),
      },
    },
    async (args) => ok(await api("POST", "/v2/search", stripUndefined(args)))
  );

  server.registerTool(
    "firecrawl_extract",
    {
      title: "Extract Structured Data",
      description:
        "Extract structured data from URLs using the local Ollama LLM. Provide urls and either a prompt or a JSON schema. Returns a job id; poll with firecrawl_extract_status.",
      inputSchema: {
        urls: z.array(z.string()).optional().describe("URLs to extract from (supports wildcards like https://example.com/*)"),
        prompt: z.string().optional().describe("What to extract"),
        schema: z.record(z.any()).optional().describe("JSON schema for the extraction output"),
        allowExternalLinks: z.boolean().optional(),
        enableWebSearch: z.boolean().optional(),
      },
    },
    async (args) => ok(await api("POST", "/v1/extract", stripUndefined(args)))
  );

  server.registerTool(
    "firecrawl_extract_status",
    {
      title: "Extract Status",
      description: "Get the status/result of an extract job.",
      inputSchema: { id: z.string().describe("Extract job id") },
    },
    async ({ id }) => ok(await api("GET", `/v1/extract/${id}`))
  );

  server.registerTool(
    "firecrawl_interact",
    {
      title: "Interact With Page",
      description:
        "Open a page in a real browser (Playwright; chromium/firefox/webkit) and interact with it. Full Playwright surface: getBy*/role/text/CSS locators, click/dblclick/hover/tap/fill/type/press/check/selectOption/dragAndDrop/upload, waits (selector/URL/loadState/function/request/response/popup/download), dialogs, downloads, tabs, frames, cookies/storage, network routing/mocking, emulation (device/geolocation/locale/timezone/colorScheme/offline), screenshots/PDF/ariaSnapshot, evaluate, assertions, tracing/HAR/video, CDP, apiRequest. Provide `actions` or a natural-language `prompt` (planned by the local Ollama model).",
      inputSchema: {
        url: z.string().url().optional().describe("Page to open (omit when reusing sessionId)"),
        sessionId: z.string().optional().describe("Reuse an existing interact session"),
        keepSession: z.boolean().optional().describe("Keep the browser session alive for follow-up calls"),
        actions: z
          .array(z.record(z.any()))
          .optional()
          .describe('Action list, e.g. [{"type":"click","target":{"getBy":"role","role":"button","name":"Save"}},{"type":"waitForURL","url":"*/done*"},{"type":"scrape"}]'),
        prompt: z.string().optional().describe("Natural-language goal (alternative to actions) — drives an Ollama agent loop that plans, acts, and answers"),
        model: z.string().optional().describe("Ollama model override for prompt mode (default OLLAMA_MODEL)"),
        maxSteps: z.number().optional().describe("Max agent iterations for prompt mode (default 5, max 12)"),
        vision: z.union([z.boolean(), z.string()]).optional().describe("Prompt-mode vision grounding: true uses INTERACT_VISION_MODEL, or pass a vision model name (e.g. qwen2.5vl)"),
        adblock: z.boolean().optional().describe("Abort tracker/ad network requests"),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
        device: z.string().optional().describe('Playwright device descriptor, e.g. "iPhone 13"'),
        viewport: z.record(z.any()).optional(),
        storageState: z.record(z.any()).optional().describe("Playwright storageState (cookies + origins) to preload"),
        recordVideo: z.boolean().optional(),
        recordHar: z.boolean().optional(),
        formats,
        timeout: z.number().optional(),
      },
    },
    async (args) => ok(await api("POST", "/v1/interact", stripUndefined(args)))
  );

  server.registerTool(
    "firecrawl_interact_async",
    {
      title: "Interact Async (Job)",
      description:
        "Same as firecrawl_interact but returns a job id immediately. Poll with firecrawl_interact_job_status for live browser events, action log, transcript and final answer.",
      inputSchema: {
        url: z.string().url().optional(),
        sessionId: z.string().optional(),
        keepSession: z.boolean().optional(),
        actions: z.array(z.record(z.any())).optional(),
        prompt: z.string().optional(),
        model: z.string().optional(),
        maxSteps: z.number().optional(),
        vision: z.union([z.boolean(), z.string()]).optional(),
        adblock: z.boolean().optional(),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
        formats,
        timeout: z.number().optional(),
      },
    },
    async (args) => ok(await api("POST", "/v1/interact/async", stripUndefined(args)))
  );

  server.registerTool(
    "firecrawl_interact_job_status",
    {
      title: "Interact Job Status",
      description: "Poll an async interact job — live browser events, action log, transcript, answer and data.",
      inputSchema: { id: z.string().describe("Interact job id from firecrawl_interact_async") },
    },
    async ({ id }) => ok(await api("GET", `/v1/interact/jobs/${id}`))
  );

  server.registerTool(
    "firecrawl_research",
    {
      title: "Research Question",
      description:
        "Answer a research question: searches via SearXNG, scrapes the top results, then synthesizes a cited answer with the local Ollama model. Returns {answer, sources, documents}.",
      inputSchema: {
        query: z.string().describe("Research question or search query"),
        limit: z.number().optional().describe("Number of sources (default 5)"),
        prompt: z.string().optional().describe("Override instruction to the synthesizer (defaults to the query)"),
        model: z.string().optional().describe("Ollama model override"),
      },
    },
    async (args) => ok(await api("POST", "/v1/research", stripUndefined(args)))
  );

  server.registerTool(
    "firecrawl_interact_sessions",
    {
      title: "List Interact Sessions",
      description: "List live interactive browser sessions.",
      inputSchema: {},
    },
    async () => ok(await api("GET", "/v1/interact/sessions"))
  );

  server.registerTool(
    "firecrawl_interact_close_session",
    {
      title: "Close Interact Session",
      description: "Close an interactive browser session.",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => ok(await api("DELETE", `/v1/interact/sessions/${sessionId}`))
  );

  return server;
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// ---------------------------------------------------------------------------
// HTTP transport — Streamable HTTP in stateless mode (one transport per
// request keeps the container simple and horizontally scalable).
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// Inbound bearer auth — the same GATEWAY_API_KEY this server forwards to the
// gateway. Anonymous access is only possible under the explicit opt-out.
app.use("/mcp", (req, res, next) => {
  if (!GATEWAY_API_KEY) return next();
  if ((req.headers.authorization || "") === `Bearer ${GATEWAY_API_KEY}`) return next();
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
});

app.all("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`firecrawl MCP server (Streamable HTTP) listening on :${PORT}/mcp`);
  console.log(`  gateway: ${GATEWAY_URL}`);
});
