#!/usr/bin/env node
/**
 * End-to-end API test for the firecrawl-extended stack.
 *
 * Exercises every endpoint at full complexity and prints a report:
 *   node scripts/test-api.mjs                 # full suite
 *   node scripts/test-api.mjs --fast          # skip LLM-heavy tests
 *   node scripts/test-api.mjs --only research # run matching tests
 *   node scripts/test-api.mjs --report out.json
 *
 * Env: GATEWAY (default http://localhost:18080), MCP (default
 * http://localhost:18081/mcp), GATEWAY_API_KEY (sent as bearer if set).
 */

const GATEWAY = (process.env.GATEWAY || "http://localhost:18080").replace(/\/$/, "");
const MCP = (process.env.MCP || "http://localhost:18081/mcp").replace(/\/$/, "");
const API_KEY = process.env.GATEWAY_API_KEY || "";

const argv = process.argv.slice(2);
const FAST = argv.includes("--fast");
const ONLY = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const REPORT = argv.includes("--report") ? argv[argv.indexOf("--report") + 1] : null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function req(method, path, body, { timeout = 120000, base = GATEWAY } = {}) {
  const t0 = performance.now();
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const ms = Math.round(performance.now() - t0);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json, ms, headers: r.headers };
}

async function poll(fn, done, { interval = 3000, timeout = 120000, label = "poll" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`${label}: timed out after ${timeout / 1000}s (last=${JSON.stringify(last?.json ?? last).slice(0, 300)})`);
}

// JSON-RPC over Streamable HTTP; the response may be plain JSON or SSE.
async function rpc(method, params = {}) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(180000),
  });
  check(r.ok, `MCP HTTP ${r.status}`);
  const text = await r.text();
  if ((r.headers.get("content-type") || "").includes("event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg.id === 1) return msg;
      }
    }
    throw new Error("MCP: no JSON-RPC response in SSE stream");
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
const tests = [
  {
    name: "gateway healthz",
    run: async () => {
      const r = await req("GET", "/healthz");
      check(r.status === 200 && r.json.status === "ok", `unexpected ${r.status}`);
    },
  },
  {
    name: "endpoint listing /api",
    run: async () => {
      const r = await req("GET", "/api");
      check(r.status === 200, `HTTP ${r.status}`);
      for (const k of ["scrape", "crawl", "map", "search", "extract", "research", "interact"])
        check(r.json.endpoints?.[k], `endpoints.${k} missing`);
    },
  },
  {
    name: "service status /status",
    run: async () => {
      const r = await req("GET", "/status", undefined, { timeout: 15000 });
      check(r.status === 200, `HTTP ${r.status}`);
      for (const svc of ["firecrawl", "playwright", "ollama", "searxng"]) {
        check(r.json[svc]?.status, `${svc} status missing`);
        check(r.json[svc].status !== "down", `${svc} is down: ${r.json[svc].error || ""}`);
      }
      check(r.json.ollama.model, "ollama model not reported");
      return Object.entries(r.json).map(([k, v]) => `${k}:${v.status}`).join(" ");
    },
  },
  {
    name: "auth enforced when GATEWAY_API_KEY set",
    skip: !API_KEY ? "no GATEWAY_API_KEY configured" : false,
    run: async () => {
      const r = await fetch(`${GATEWAY}/api`).then((x) => x.status);
      check(r === 401, `expected 401 without key, got ${r}`);
    },
  },
  {
    name: "v1/scrape markdown+links",
    run: async () => {
      const r = await req("POST", "/v1/scrape", {
        url: "https://example.com",
        formats: ["markdown", "links"],
        onlyMainContent: true,
      });
      check(r.status === 200 && r.json.success, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
      // example.com was redesigned (no <h1> anymore) — title lives in metadata.
      check(r.json.data.metadata?.title === "Example Domain", `title wrong: ${r.json.data.metadata?.title}`);
      check(r.json.data.markdown?.includes("documentation"), "markdown missing body text");
      check(Array.isArray(r.json.data.links), "links not an array");
    },
  },
  {
    name: "v2/scrape with json extraction",
    slow: true,
    run: async () => {
      const r = await req("POST", "/v2/scrape", {
        url: "https://example.com",
        formats: [
          "markdown",
          {
            type: "json",
            prompt: "Extract the page title and the first paragraph.",
            schema: {
              type: "object",
              properties: { title: { type: "string" }, firstParagraph: { type: "string" } },
            },
          },
        ],
      }, { timeout: 300000 });
      check(r.status === 200 && r.json.success, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
      check(r.json.data.json && typeof r.json.data.json === "object", "json format output missing");
    },
  },
  {
    name: "v2/search",
    run: async () => {
      const r = await req("POST", "/v2/search", { query: "firecrawl web scraping", limit: 3 });
      check(r.status === 200 && r.json.success, `HTTP ${r.status}`);
      const web = r.json.data?.web ?? [];
      check(web.length > 0 && web[0].url, "no web results");
      return `${web.length} results, first=${web[0].url?.slice(0, 60)}`;
    },
  },
  {
    name: "v2/map",
    run: async () => {
      const r = await req("POST", "/v2/map", { url: "https://news.ycombinator.com", limit: 10 });
      check(r.status === 200 && r.json.success !== false, `HTTP ${r.status}`);
      const links = r.json.links ?? [];
      check(links.length > 0, "no links discovered");
      return `${links.length} links`;
    },
  },
  {
    name: "v2/batch/scrape lifecycle",
    run: async () => {
      const r = await req("POST", "/v2/batch/scrape", {
        urls: ["https://example.com", "https://www.iana.org/domains/example"],
        formats: ["markdown"],
      });
      check(r.status === 200 && r.json.success && r.json.id, `no job id: ${JSON.stringify(r.json).slice(0, 200)}`);
      const job = await poll(
        () => req("GET", `/v2/batch/scrape/${r.json.id}`),
        (p) => ["completed", "failed"].includes(p.json.status),
        { timeout: 180000, label: "batch scrape" }
      );
      check(job.json.status === "completed", `job ${job.json.status}`);
      check((job.json.data ?? []).length === 2, `expected 2 docs, got ${(job.json.data ?? []).length}`);
    },
  },
  {
    name: "v2/crawl lifecycle + cancel",
    run: async () => {
      const r = await req("POST", "/v2/crawl", {
        url: "https://example.com",
        limit: 2,
        scrapeOptions: { formats: ["markdown"] },
      });
      check(r.status === 200 && r.json.success && r.json.id, `no job id: ${JSON.stringify(r.json).slice(0, 200)}`);
      const id = r.json.id;
      try {
        const job = await poll(
          () => req("GET", `/v2/crawl/${id}`),
          (p) => ["completed", "failed"].includes(p.json.status),
          { timeout: 90000, interval: 4000, label: "crawl" }
        );
        check(job.json.status === "completed", `crawl ${job.json.status}`);
        check((job.json.data ?? []).length >= 1, "no crawled pages");
        return `completed, ${(job.json.data ?? []).length} pages`;
      } catch {
        // Slow crawl -> exercise cancel instead.
        const c = await req("DELETE", `/v2/crawl/${id}`);
        check(c.status === 200, `cancel failed: HTTP ${c.status}`);
        return "cancelled (still running after 90s)";
      }
    },
  },
  {
    name: "v1/extract (Ollama shim)",
    slow: true,
    run: async () => {
      const r = await req("POST", "/v1/extract", {
        urls: ["https://example.com"],
        prompt: "Extract the page title and main heading.",
        schema: {
          type: "object",
          properties: { title: { type: "string" }, heading: { type: "string" } },
        },
      }, { timeout: 300000 });
      check(r.status === 200 && r.json.success, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
      check(r.json.data && typeof r.json.data === "object", "no extracted data");
    },
  },
  {
    name: "v1/research compound query (decompose+rounds)",
    slow: true,
    run: async () => {
      const r = await req("POST", "/v1/research", {
        query: "Which airlines fly nonstop from Abbotsford (YXX), and name one boutique hotel in Victoria BC?",
        limit: 5,
      }, { timeout: 600000 });
      check(r.status === 200 && r.json.success, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
      check(typeof r.json.answer === "string" && r.json.answer.length > 20, "answer missing/thin");
      check(Array.isArray(r.json.queries) && r.json.queries.length >= 2,
        `expected decomposed queries, got ${JSON.stringify(r.json.queries)}`);
      check(r.json.rounds >= 1 && r.json.rounds <= 2, `rounds=${r.json.rounds}`);
      check(Array.isArray(r.json.sources), "sources missing");
      check(Array.isArray(r.json.documents) && r.json.documents.length > 0, "documents missing");
      return `queries=${r.json.queries.length} rounds=${r.json.rounds} docs=${r.json.documents.length}`;
    },
  },
  {
    name: "v1/interact actions (locators+assert+scrape)",
    run: async () => {
      const r = await req("POST", "/v1/interact", {
        url: "https://news.ycombinator.com",
        actions: [
          { type: "click", target: { getBy: "role", role: "link", name: "new", exact: true }, waitForLoadState: "domcontentloaded" },
          { type: "assert", target: { selector: "title" }, assertions: [{ type: "toContainText", value: "Hacker News" }] },
          { type: "scrape" },
        ],
        formats: ["markdown", "links", "ariaSnapshot"],
      }, { timeout: 120000 });
      check(r.status === 200 && r.json.success, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
      check(r.json.data?.markdown?.length > 100, "markdown empty");
      check(Array.isArray(r.json.actionsLog) && r.json.actionsLog.length >= 3, "actionsLog incomplete");
      check(r.json.data.links?.length > 5, "links missing");
      return `${r.json.actionsLog.length} actions, url=${r.json.data?.metadata?.url ?? ""}`;
    },
  },
  {
    name: "v1/interact/async job lifecycle",
    run: async () => {
      const r = await req("POST", "/v1/interact/async", {
        url: "https://example.com",
        actions: [{ type: "scrape" }],
        formats: ["markdown"],
      });
      check(r.status === 202 && r.json.id, `expected 202+id: ${JSON.stringify(r.json).slice(0, 200)}`);
      const job = await poll(
        () => req("GET", `/v1/interact/jobs/${r.json.id}`),
        (p) => ["completed", "failed"].includes(p.json.status),
        { timeout: 120000, label: "interact job" }
      );
      check(job.json.status === "completed", `job ${job.json.status}: ${job.json.error || ""}`);
      check(Array.isArray(job.json.events), "events missing");
      check(job.json.data?.markdown?.includes("documentation"), "job markdown wrong");
      return `events=${job.json.events.length}`;
    },
  },
  {
    name: "interact sessions lifecycle + artifacts",
    run: async () => {
      const c = await req("POST", "/v1/interact/sessions", { url: "https://example.com", browser: "chromium" });
      check(c.status === 200 && c.json.sessionId, `no sessionId: ${JSON.stringify(c.json).slice(0, 200)}`);
      const sid = c.json.sessionId;
      try {
        const l = await req("GET", "/v1/interact/sessions");
        check(l.json.sessions?.some((s) => s.id === sid), "session not listed");
        const a = await req("GET", `/v1/interact/sessions/${sid}/artifacts/events`);
        check(a.status === 200 && a.json.success, `events artifact: HTTP ${a.status}`);
        // reuse the session for a follow-up action
        const u = await req("POST", "/v1/interact", {
          sessionId: sid,
          actions: [{ type: "assert", assertions: [{ type: "toHaveTitle", value: "Example Domain" }] }],
        }, { timeout: 60000 });
        check(u.status === 200 && u.json.success, `session reuse failed: ${JSON.stringify(u.json).slice(0, 200)}`);
      } finally {
        const d = await req("DELETE", `/v1/interact/sessions/${sid}`);
        check(d.status === 200 && d.json.success, `delete: HTTP ${d.status}`);
      }
      const l2 = await req("GET", "/v1/interact/sessions");
      check(!l2.json.sessions?.some((s) => s.id === sid), "session still listed after delete");
      return "created, reused, events artifact, deleted";
    },
  },
  {
    name: "v1/interact prompt mode (Ollama agent)",
    slow: true,
    run: async () => {
      const r = await req("POST", "/v1/interact", {
        url: "https://example.com",
        prompt: "What is the main heading on this page? Answer with just the heading text.",
        maxSteps: 3,
      }, { timeout: 480000 });
      check(r.status === 200 && r.json.success, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
      check(typeof r.json.answer === "string" && r.json.answer.length > 0, "no agent answer");
      return `answer="${r.json.answer.slice(0, 60)}" steps=${r.json.transcript?.length ?? "?"}`;
    },
  },
  {
    name: "negative: research without query -> 400",
    run: async () => {
      const r = await req("POST", "/v1/research", { limit: 2 });
      check(r.status === 400, `expected 400, got ${r.status}`);
    },
  },
  {
    name: "negative: bogus interact job -> 404",
    run: async () => {
      const r = await req("GET", "/v1/interact/jobs/does-not-exist");
      check(r.status === 404, `expected 404, got ${r.status}`);
    },
  },
  {
    name: "MCP tools/list + tools/call scrape",
    run: async () => {
      const list = await rpc("tools/list");
      const tools = list.result?.tools ?? [];
      check(tools.length >= 14, `expected >=14 tools, got ${tools.length}`);
      for (const t of ["firecrawl_scrape", "firecrawl_search", "firecrawl_research",
        "firecrawl_interact", "firecrawl_interact_async", "firecrawl_extract"])
        check(tools.some((x) => x.name === t), `tool ${t} missing`);
      const call = await rpc("tools/call", {
        name: "firecrawl_scrape",
        arguments: { url: "https://example.com", formats: ["markdown"] },
      });
      const text = call.result?.content?.[0]?.text ?? "";
      const payload = JSON.parse(text);
      check(payload.data?.markdown?.includes("documentation"), "MCP scrape returned no markdown");
      return `${tools.length} tools, scrape ok`;
    },
  },
];

// ---------------------------------------------------------------------------
// runner + report
// ---------------------------------------------------------------------------
const results = [];
const t0all = performance.now();
for (const t of tests) {
  if (ONLY && !t.name.includes(ONLY)) continue;
  if (FAST && t.slow) results.push({ name: t.name, status: "SKIP", note: "--fast" });
  else if (t.skip) results.push({ name: t.name, status: "SKIP", note: t.skip });
  else {
    const t0 = performance.now();
    try {
      const note = await t.run();
      results.push({ name: t.name, status: "PASS", ms: Math.round(performance.now() - t0), note });
    } catch (e) {
      results.push({ name: t.name, status: "FAIL", ms: Math.round(performance.now() - t0), error: String(e.message || e) });
    }
  }
  const r = results[results.length - 1];
  const tag = r.status === "PASS" ? "\x1b[32mPASS\x1b[0m" : r.status === "FAIL" ? "\x1b[31mFAIL\x1b[0m" : "\x1b[33mSKIP\x1b[0m";
  const detail = r.error ? ` — ${r.error}` : r.note ? ` — ${r.note}` : "";
  console.log(`${tag}  ${r.name.padEnd(52)} ${((r.ms ?? 0) / 1000).toFixed(1)}s${detail}`);
}

const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const skip = results.filter((r) => r.status === "SKIP").length;
const total = ((performance.now() - t0all) / 1000).toFixed(1);
console.log("─".repeat(70));
console.log(`${pass} passed, ${fail} failed, ${skip} skipped · ${total}s · gateway=${GATEWAY}`);

if (REPORT) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(REPORT, JSON.stringify({ gateway: GATEWAY, mcp: MCP, at: new Date().toISOString(), pass, fail, skip, totalSec: +total, results }, null, 2));
  console.log(`report written to ${REPORT}`);
}
process.exit(fail ? 1 : 0);
