import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "8080", 10);
const FIRECRAWL_API_URL = (process.env.FIRECRAWL_API_URL || "http://api:3002").replace(/\/$/, "");
const INTERACT_SERVICE_URL = (process.env.INTERACT_SERVICE_URL || "http://interact:3001").replace(/\/$/, "");
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || "";
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://ollama:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || "180000", 10);

// Internal service probes for GET /status (drives the UI status pills).
const PROBES = {
  firecrawl: `${FIRECRAWL_API_URL}/`,
  playwright: (process.env.PLAYWRIGHT_SERVICE_URL || "http://playwright-service:3000").replace(/\/$/, "") + "/",
  ollama: `${OLLAMA_BASE_URL}/api/tags`,
  searxng: (process.env.SEARXNG_ENDPOINT || "http://searxng:8080").replace(/\/$/, "") + "/healthz",
};
const PROBE_TIMEOUT_MS = 3000;
const PROBE_SLOW_MS = 2000;

const app = express();
app.disable("x-powered-by");

// ---------------------------------------------------------------------------
// Optional bearer auth for the single external interface.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (!GATEWAY_API_KEY || req.path === "/healthz") return next();
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${GATEWAY_API_KEY}`) return next();
  return res.status(401).json({ success: false, error: "Unauthorized" });
});

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// GET /status - per-service health for the console UI pills.
//   ok       : HTTP response < 500 within timeout
//   degraded : reachable but 5xx, or slower than PROBE_SLOW_MS
//   down     : unreachable / timed out
// ---------------------------------------------------------------------------
async function probe(url) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const ms = Math.round(performance.now() - t0);
    return {
      status: r.status >= 500 ? "degraded" : ms > PROBE_SLOW_MS ? "degraded" : "ok",
      ms,
      httpStatus: r.status,
    };
  } catch (e) {
    return { status: "down", error: String(e.cause?.code || e.message || e) };
  }
}

app.get("/status", async (_req, res) => {
  const entries = Object.entries(PROBES);
  const results = await Promise.all(entries.map(([, url]) => probe(url)));
  const out = Object.fromEntries(entries.map(([name], i) => [name, results[i]]));
  // Enrich ollama with the configured model + which models are resident.
  // A large model that isn't loaded explains most "why is this hanging" cases.
  if (out.ollama?.status === "ok") {
    out.ollama.model = OLLAMA_MODEL;
    try {
      const r = await fetch(`${OLLAMA_BASE_URL}/api/ps`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const ps = await r.json();
      out.ollama.loadedModels = (ps.models || []).map((m) => m.name);
      out.ollama.modelLoaded = out.ollama.loadedModels.some((n) => n === OLLAMA_MODEL || n.startsWith(`${OLLAMA_MODEL.split(":")[0]}:`));
    } catch { /* loaded-model info best-effort */ }
  }
  res.json(out);
});

// ---------------------------------------------------------------------------
// /v1/extract compatibility shim.
// Upstream deprecated the async extract job API in favour of `POST /v2/scrape`
// with a `json` format. This route preserves a working extract endpoint backed
// by Ollama: it fans out to /v2/scrape (json format) per URL, expanding `*`
// wildcard URLs via /v2/map and falling back to /v2/search when only a prompt
// is given.
// ---------------------------------------------------------------------------
async function apiCall(method, path, body) {
  const r = await fetch(`${FIRECRAWL_API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return json;
}

app.post("/v1/extract", express.json({ limit: "10mb" }), async (req, res) => {
  const { urls = [], prompt, schema, systemPrompt, agent } = req.body || {};
  try {
    let targets = [];
    for (const u of urls) {
      if (typeof u === "string" && u.includes("*")) {
        const base = u.replace(/\*.*$/, "");
        const m = await apiCall("POST", "/v2/map", { url: base, limit: 20 });
        targets.push(
          ...(m.links || [])
            .slice(0, 20)
            .map((l) => (typeof l === "string" ? l : l.url))
            .filter(Boolean)
        );
      } else {
        targets.push(u);
      }
    }
    if (!targets.length && prompt) {
      const s = await apiCall("POST", "/v2/search", { query: prompt, limit: 5 });
      const hits = s.data?.web ?? s.data ?? [];
      targets.push(...hits.map((r) => r.url).filter(Boolean));
    }
    targets = [...new Set(targets)].slice(0, 10);
    if (!targets.length) {
      return res.status(400).json({ success: false, error: "No URLs to extract from." });
    }

    const results = await Promise.all(
      targets.map(async (u) => {
        try {
          const jsonFormat = { type: "json", prompt, schema };
          if (systemPrompt) jsonFormat.systemPrompt = systemPrompt;
          if (agent) jsonFormat.agent = agent;
          const r = await apiCall("POST", "/v2/scrape", { url: u, formats: [jsonFormat] });
          return { url: u, success: true, data: r.data?.json ?? null };
        } catch (e) {
          return { url: u, success: false, error: String(e.message || e) };
        }
      })
    );

    res.json({
      success: true,
      status: "completed",
      data: results.length === 1 ? results[0].data : results,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/research — composed answer endpoint.
//   /v2/search (with per-result markdown scrape) -> ground Ollama on the
//   documents -> {"answer", "sources", "documents"}. The reliable alternative
//   to browser-agent prompt mode for question-answering tasks.
// ---------------------------------------------------------------------------
app.post(["/v1/research", "/v2/research"], express.json({ limit: "10mb" }), async (req, res) => {
  const { query, limit = 5, prompt, model } = req.body || {};
  if (!query) return res.status(400).json({ success: false, error: "Provide `query`." });
  try {
    const s = await apiCall("POST", "/v2/search", {
      query,
      limit,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    });
    // v2 search groups results under data.web/news/images; v1 uses data[].
    const groups = s.data && typeof s.data === "object" && !Array.isArray(s.data)
      ? Object.values(s.data).flat()
      : Array.isArray(s.data) ? s.data : [];
    const hits = groups.filter((r) => r && r.url).slice(0, limit);
    if (!hits.length) {
      return res.status(404).json({ success: false, error: "Search returned no results." });
    }

    const docs = hits
      .map((h, i) => `### [${i + 1}] ${h.title || h.url}\n${h.url}\n\n${(h.markdown || h.description || "").slice(0, 4000)}`)
      .join("\n\n---\n\n");
    const question = prompt || query;

    const r = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model: model || OLLAMA_MODEL,
        keep_alive: "30m",
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [
          {
            role: "system",
            content: 'You answer questions using ONLY the provided documents. Reply with JSON {"answer":"...","sources":["https://..."]}. Quote specific facts from the documents and cite only the URLs you used. If the documents cannot answer, say so in "answer" and use "sources":[].',
          },
          { role: "user", content: `Question: ${question}\n\nDocuments:\n${docs}` },
        ],
      }),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const llm = await r.json();
    let out = {};
    try { out = JSON.parse(llm?.message?.content ?? "{}"); }
    catch { out = { answer: String(llm?.message?.content ?? "") }; }

    res.json({
      success: true,
      answer: out.answer ?? "",
      sources: Array.isArray(out.sources) && out.sources.length ? out.sources : hits.map((h) => h.url),
      documents: hits.map((h) => ({
        url: h.url, title: h.title, description: h.description, markdown: h.markdown,
      })),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// Web console UI (same origin -> no CORS, single external interface).
app.use(express.static(join(__dirname, "..", "public")));
app.get("/", (_req, res) =>
  res.sendFile(join(__dirname, "..", "public", "index.html"))
);

app.get("/api", (_req, res) =>
  res.json({
    name: "firecrawl-extended gateway",
    docs: "All open-source self-hosted Firecrawl endpoints are proxied under /v0, /v1 and /v2.",
    endpoints: {
      scrape: "POST /v1/scrape (or /v2/scrape for json formats)",
      batchScrape: "POST /v2/batch/scrape",
      batchScrapeStatus: "GET /v2/batch/scrape/:id",
      crawl: "POST /v2/crawl",
      crawlStatus: "GET /v2/crawl/:id",
      crawlCancel: "DELETE /v2/crawl/:id",
      map: "POST /v2/map",
      search: "POST /v2/search",
      extract: "POST /v1/extract",
      extractStatus: "GET /v1/extract/:id",
      research: "POST /v1/research (search + scrape + Ollama answer)",
      interact: "POST /v1/interact",
      interactAsync: "POST /v1/interact/async",
      interactJob: "GET /v1/interact/jobs/:id",
      interactSessions: "GET|DELETE /v1/interact/sessions[/:id]",
      mcp: "MCP interface available on the mcp service (/mcp, Streamable HTTP)",
    },
  })
);

// ---------------------------------------------------------------------------
// Transparent reverse proxy. Any path we don't own goes straight to the
// Firecrawl API, which keeps every present and future upstream endpoint
// available through this one interface.
// ---------------------------------------------------------------------------
const INTERACT_PATHS = /^\/v[12]\/interact(\/.*)?$/;

async function proxy(upstream, req, res) {
  const url = `${upstream}${req.originalUrl}`;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  delete headers["connection"];

  const hasBody = !["GET", "HEAD"].includes(req.method);
  try {
    const upstreamRes = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
    });

    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((value, key) => {
      if (!["transfer-encoding", "connection", "content-length"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) await new Promise((r) => res.once("drain", r));
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ success: false, error: `Upstream error: ${err.message}` });
    } else {
      res.end();
    }
  }
}

app.use((req, res) => {
  const upstream = INTERACT_PATHS.test(req.path) ? INTERACT_SERVICE_URL : FIRECRAWL_API_URL;
  proxy(upstream, req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`gateway listening on :${PORT}`);
  console.log(`  firecrawl upstream: ${FIRECRAWL_API_URL}`);
  console.log(`  interact upstream:  ${INTERACT_SERVICE_URL}`);
});
