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
// Compound questions ("fly A to B, stay at a boutique hotel in C, eat
// seafood") fail as a single search — one query can't satisfy several
// facets, so engines return noise matching the weakest terms. Ask the
// model to split the question into focused sub-queries; falls back to the
// raw query when decomposition fails or produces nothing usable.
async function decomposeQuery(query, model) {
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: model || OLLAMA_MODEL,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [
          {
            role: "system",
            content:
              'Rewrite the question as focused web search queries. Reply with JSON {"queries":["...","..."]}. ' +
              "Single-fact questions need one query (possibly rephrased). Multi-part questions need one query per part — a search engine answers each part poorly if they are merged into one query. " +
              "For questions asking for things satisfying several conditions at once (an intersection, e.g. 'cruise lines for over-50s that stop in Cozumel'), emit one query per CONDITION ('best cruise lines for travelers over 50', 'cruise lines that stop in Cozumel') — merged condition queries retrieve poorly; the synthesis step intersects them. " +
              "Preserve qualifiers and disambiguate with context from the question (a city next to a named destination means the nearby city, not a same-named one elsewhere). Max 4 queries.",
          },
          { role: "user", content: query },
        ],
      }),
    });
    if (!r.ok) return [query];
    const llm = await r.json();
    const parsed = JSON.parse(llm?.message?.content ?? "{}");
    const queries = (parsed.queries || [])
      .filter((q) => typeof q === "string" && q.trim().length > 3)
      .map((q) => q.trim())
      .slice(0, 4);
    return queries.length ? [...new Set(queries)] : [query];
  } catch {
    return [query];
  }
}

app.post(["/v1/research", "/v2/research"], express.json({ limit: "10mb" }), async (req, res) => {
  const { query, limit = 5, prompt, model } = req.body || {};
  if (!query) return res.status(400).json({ success: false, error: "Provide `query`." });
  try {
    const queries = await decomposeQuery(query, model);

    // Run /v2/search per sub-query, then round-robin merge so every facet
    // keeps representation within `cap` instead of the first sub-query
    // consuming the whole budget. Dedupes against `seen`, so later rounds
    // only add fresh documents.
    const seen = new Set();
    const hits = [];
    const retrieve = async (qs, cap) => {
      const searches = await Promise.all(
        qs.map((q) =>
          apiCall("POST", "/v2/search", {
            query: q,
            limit,
            scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
          }).catch(() => ({ data: [] }))
        )
      );
      // v2 search groups results under data.web/news/images; v1 uses data[].
      const perQuery = searches.map((s) => {
        const groups = s.data && typeof s.data === "object" && !Array.isArray(s.data)
          ? Object.values(s.data).flat()
          : Array.isArray(s.data) ? s.data : [];
        return groups.filter((r) => r && r.url);
      });
      let added = 0;
      for (let i = 0; hits.length < cap; i++) {
        let any = false;
        for (const list of perQuery) {
          const h = list[i];
          if (h && !seen.has(h.url)) {
            seen.add(h.url);
            hits.push(h);
            added++;
            any = true;
            if (hits.length >= cap) break;
          }
        }
        if (!any) break;
      }
      return added;
    };
    await retrieve(queries, limit);
    if (!hits.length) {
      return res.status(404).json({ success: false, error: "Search returned no results." });
    }

    // Excerpting: head-of-document slicing drops relevant sections buried
    // deep in long pages. Score paragraphs by query-term overlap and keep
    // the head plus the best-scoring windows within a per-doc budget sized
    // to hold total context ~24k chars as the doc count grows.
    const buildDocs = () => {
      const terms = [...new Set(queries.join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3))];
      const budget = Math.max(1200, Math.floor(24000 / hits.length));
      const excerpt = (text) => {
        if (!text || text.length <= budget) return text || "";
        const paras = text.split(/\n{2,}/);
        const scored = paras.map((p, i) => {
          const l = p.toLowerCase();
          const score = terms.reduce((s, t) => s + (l.includes(t) ? 1 : 0), 0);
          return { p, i, score };
        });
        const top = scored
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 8);
        // Answers often live in the paragraph *after* a matching heading —
        // include the next sibling of each hit so they aren't cut.
        const idx = new Set();
        for (const s of top) { idx.add(s.i); idx.add(s.i + 1); }
        const picked = [...idx].sort((a, b) => a - b).map((i) => paras[i]).filter(Boolean);
        let out = text.slice(0, Math.min(1500, budget / 3));
        for (const p of picked) {
          if (out.length + p.length + 30 > budget) break;
          if (!out.includes(p)) out += `\n\n[…]\n\n${p}`;
        }
        return out;
      };
      return hits
        .map((h, i) => {
          const body = h.markdown || h.description || "";
          // Unscrapable/thin docs (bot-walls, social posts) get flagged —
          // title/description remain usable evidence, but page detail is
          // unverified.
          const thin = (h.markdown || "").trim().length < 300;
          return `### [${i + 1}] ${h.title || h.url}\n${h.url}${thin ? "\n(unscrapable — title+description only; usable for existence facts, detail unverified)" : ""}\n\n${excerpt(body)}`;
        })
        .join("\n\n---\n\n");
    };

    const question = prompt || query;
    const synthesize = async () => {
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
              content: 'You answer questions using ONLY the provided documents. Reply with JSON {"answer":"...","sources":["https://..."],"gaps":["..."]}. Quote specific facts from the documents and cite only the URLs you used. If the question asks for a set or list ("which", "all", "what ships/products/..."), enumerate every qualifying item found in the documents — including secondary, occasional, seasonal, or edge cases — distinguishing them from the primary answer rather than naming only the most prominent one. When the question is about which places/routes/carriers are served, interpret it as direct/nonstop service — a multi-stop itinerary can reach anywhere, so connecting destinations are noise; mention them only if the question asks about connections. When documents conflict, prefer official/first-party sources (the entity\'s own site, .gov, operator/venue pages) and note the discrepancy. Treat aggregator/marketplace enumerations (booking sites, directories) as upper bounds — they often include resellers, codeshares, or stale entries; prefer sources that directly operate or own what is being listed. Places and entities with the same name are common (Saint Petersburg FL vs Russia, Springfield, Vancouver BC vs WA): check each document actually covers the place the question means — discard same-named-elsewhere documents entirely and do not cite or name their contents. A snippet-only document still has a usable title and description — for existence facts a first-party page title is directly probative (an operator page titled "Cruises to Cozumel" proves the line sails there), so use it but say the detail level is unverified. For questions asking for entities that satisfy several conditions at once (an intersection — e.g. "lines for over-50s that stop in Cozumel"), combine evidence ACROSS documents: an entity confirmed for condition A by one document and condition B by another is a valid answer citing both URLs. In "gaps", list each distinct part of the question the documents could NOT answer, phrased as a standalone web search query — an empty array if the documents cover the question; these drive a follow-up retrieval round, so make them specific and self-contained. For intersection questions, prefer one gap query per candidate entity ("<entity> <missing condition>") over repeating the whole compound question. If the documents cannot answer, say so in "answer" and use "sources":[].',
            },
            { role: "user", content: `Question: ${question}\n\nDocuments:\n${buildDocs()}` },
          ],
        }),
      });
      if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
      const llm = await r.json();
      try { return JSON.parse(llm?.message?.content ?? "{}"); }
      catch { return { answer: String(llm?.message?.content ?? "") }; }
    };

    // Two-round retrieve loop: if synthesis reports facets the documents
    // couldn't cover ("gaps"), search those gaps once more, merge the fresh
    // documents, and synthesize again over old + new evidence.
    let out = {};
    let rounds = 0;
    for (let round = 1; ; round++) {
      rounds = round;
      out = await synthesize();
      const gaps = Array.isArray(out.gaps)
        ? [...new Set(out.gaps.filter((g) => typeof g === "string" && g.trim().length > 3).map((g) => g.trim()))].slice(0, 5)
        : [];
      if (round >= 2 || !gaps.length) break;
      const fresh = gaps.filter((g) => !queries.includes(g));
      queries.push(...fresh);
      if (!fresh.length || !(await retrieve(fresh, hits.length + limit))) break;
    }

    res.json({
      success: true,
      answer: out.answer ?? "",
      queries,
      rounds,
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
