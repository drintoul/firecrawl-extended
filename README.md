# firecrawl-extended

Self-hosted [Firecrawl](https://github.com/firecrawl/firecrawl) with a unified
REST gateway, a web console, an MCP interface, a custom Playwright interaction
service, and Ollama-backed LLM extraction.

```
 external:
   browser / curl ─▶ :18080  gateway   single REST interface + web console
   mcp clients    ─▶ :18081  mcp       Streamable HTTP; calls gateway internally

 gateway routes:
   /v0, /v1, /v2  (any path)   ─▶ api        upstream Firecrawl API + workers
   /v1/interact                ─▶ interact   Playwright browser sessions
   /v1/extract                 ─▶ shim: map/search ─▶ /v2/scrape ─▶ ollama
   /  /api  /status  /healthz  ─▶ gateway itself

 internal:    api ─▶ playwright-service · redis · rabbitmq · nuq-postgres
 llm-network: api, interact, gateway ─▶ ollama :11434 · searxng :8080
```

## Why I built this

The open-source Firecrawl is a solid fetch-based scraper, but self-hosting it
leaves a few gaps:

- **No real browser you can drive.** Upstream scrapes via a fast HTTP/fetch
  engine whenever possible, and interactive `actions` are gated behind the
  commercial Fire Engine — so no clicking, form-filling, or reliable
  screenshots. `POST /v1/interact` fills that gap with full Playwright:
  locators, waits, assertions, tracing, all three engines.
- **The extract job API was deprecated upstream.** The gateway re-implements
  `/v1/extract` synchronously on top of `/v2/scrape`, with a local Ollama
  model doing the structured extraction — no external LLM calls.
- **No single front door or UI.** Upstream exposes the API on its own port
  and ships no console. Here everything — upstream endpoints, interact,
  extract — sits behind one gateway on `:18080`, with a built-in web console
  for driving it, and an MCP interface on `:18081` so agents get the same
  surface as tools.

## Services

| Container | Image / build | Role |
|---|---|---|
| `firecrawl-extended-gateway` | `./gateway` | **The one external REST interface** (`:18080`). Serves the web console at `/`, proxies every upstream endpoint (`/v0`–`/v2`), adds `/v1/interact` + a working `/v1/extract`. Optional bearer auth. |
| `firecrawl-extended-mcp` | `./mcp` | **The MCP interface** (`:18081/mcp`, Streamable HTTP). All Firecrawl capabilities as tools; forwards `GATEWAY_API_KEY`. |
| `firecrawl-extended-interact` | `./interact` | Custom Playwright service backing `POST /v1/interact`: stateful sessions, full action surface, Ollama prompt→action planner. Internal only. |
| `firecrawl-extended-api` | `ghcr.io/firecrawl/firecrawl` | Upstream API + embedded workers. Not published — reachable only via the gateway. |
| `firecrawl-extended-playwright-service` | `ghcr.io/firecrawl/playwright-service` | Upstream JS-rendering microservice used by `api`. |
| `firecrawl-extended-redis` | `redis:alpine` | Rate limits / queue state (AOF on, `./data/redis`). |
| `firecrawl-extended-rabbitmq` | `rabbitmq:3-management` | Job queue (`./data/rabbitmq`). |
| `firecrawl-extended-nuq-postgres` | `ghcr.io/firecrawl/nuq-postgres` | NuQ job store (`./data/postgres`). |

All data persists on the host under `./data/` (postgres, rabbitmq, redis,
interact artifacts). `data/fdb` and `data/firecrawl-postgres` are leftovers
from earlier deployments and unused — safe to delete.

## External dependencies

The stack expects an **Ollama** container and a **SearXNG** container (JSON
output enabled) reachable by DNS name on the shared Docker network
`llm-network` — on this host they already exist and provide `llama3.1:8b` +
`nomic-embed-text`. `api` and `interact` join that network and reach them as
`http://ollama:11434` and `http://searxng:8080`.

On a fresh host:

```bash
docker network create llm-network
docker run -d --name ollama --network llm-network -p 11434:11434 \
  -v ollama-data:/root/.ollama ollama/ollama
docker exec ollama ollama pull llama3.1:8b && docker exec ollama ollama pull nomic-embed-text
docker run -d --name searxng --network llm-network -p 8088:8080 \
  -v "$PWD/searxng:/etc/searxng" searxng/searxng   # uses searxng/settings.yml (JSON enabled)
```

Or point `OLLAMA_BASE_URL` / `SEARXNG_ENDPOINT` in `.env` at any reachable
instance (e.g. `http://host.docker.internal:11434`).

## Quick start

```bash
cp .env.example .env        # set POSTGRES_PASSWORD (and optionally GATEWAY_API_KEY)
docker compose up -d
```

Verify:

```bash
curl -s http://localhost:18080/healthz
curl -s -X POST http://localhost:18080/v1/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "formats": ["markdown"]}'
```

## Web console

`http://localhost:18080/` serves a self-contained console UI (single page, no
build step, no external assets) that talks to the gateway same-origin — no
CORS or extra ports. Features:

- **Live service status pills** in the header — firecrawl, ollama, searxng,
  playwright — probed via `GET /status` every 15 s (green ok / orange
  degraded / red down, with latency + error tooltip).
- **Endpoint presets** (scrape, v2 scrape-json, extract, map, search, batch,
  crawl lifecycle, interact, sessions) grouped by workflow; each fills
  method badge + path + body.
- **Request builder**: color-coded read-only method badge (set by presets),
  free-form path with `:param` placeholders (`/v1/crawl/:id` auto-fills from
  the last job id or prompts), JSON body editor that auto pretty-prints.
- **Response viewer**: status + latency badge, three tabs — pretty JSON,
  rendered markdown (link extraction, hard-break cleanup, images pulled
  out), and media (screenshots/PDF inline + images extracted from markdown).
- **Copy icons** in each panel header: request → full cURL command; response
  → whatever the active tab shows (JSON text, markdown source, or the
  screenshot as a real image on the clipboard).
- **Job polling**: POSTs returning a job `id` get a "Poll job" button plus an
  auto-poll-until-done toggle.
- **History panel** below Request: the 5 most recent requests as a clickable
  list (20 kept in `localStorage`).
- API key field (bearer, persisted in `localStorage`).

The machine-readable endpoint listing lives at `GET /api`.

## REST endpoints (through the gateway, `:18080`)

All upstream endpoints are proxied verbatim — request/response shapes match
the [Firecrawl API reference](https://docs.firecrawl.dev/api-reference/introduction).

| Endpoint | Description |
|---|---|
| `GET /healthz` | Gateway health |
| `GET /api` | JSON listing of all endpoints |
| `GET /status` | Per-service health (firecrawl/ollama/searxng/playwright) — powers the console pills |
| `POST /v1/scrape` | Scrape a URL → markdown/html/links/screenshot/json |
| `POST /v1/batch/scrape` | Async batch scrape → job id |
| `GET/DELETE /v1/batch/scrape/:id` | Batch status / cancel (+ `/errors`) |
| `POST /v1/crawl` | Async crawl → job id |
| `GET/DELETE /v1/crawl/:id` | Crawl status / cancel (+ `/errors`, `GET /v1/crawl/active`) |
| `POST /v1/map` | Discover all URLs on a site |
| `POST /v1/search` | Web search via SearXNG (+ optional scraping) |
| `POST /v1/extract` | **Shimmed.** LLM extraction via Ollama — expands `*` URLs via `/v1/map`, falls back to `/v1/search` when only `prompt` is given, synchronous result |
| `POST /v2/scrape` | Upstream structured extraction: `formats: [{type:"json", prompt, schema}]` |
| `POST /v1/interact` | **Custom.** Playwright-driven interaction (below) |
| `GET/POST /v1/interact/sessions` | List / create interact sessions |
| `DELETE /v1/interact/sessions/:id` | Close a session |
| `GET /v1/interact/sessions/:id/artifacts/:name` | Fetch trace.zip / session.har / video artifacts |

Any other `/v0`, `/v1`, or `/v2` path is forwarded to the upstream API as-is.

### `POST /v1/interact`

Playwright-backed interactive browser sessions implementing the API surface
from <https://playwright.dev/>. Bodies accept either an `actions` list or a
`prompt` planned by Ollama.

```json
{
  "url": "https://news.ycombinator.com",
  "browser": "chromium",
  "device": "Desktop Chrome",
  "actions": [
    { "type": "click", "target": { "getBy": "role", "role": "link", "name": "new" } },
    { "type": "fill", "target": { "getBy": "label", "value": "Search" }, "text": "firecrawl" },
    { "type": "press", "key": "Enter", "waitForLoadState": "networkidle" },
    { "type": "assert", "target": { "selector": "title" },
      "assertions": [{ "type": "toContainText", "value": "Hacker" }] },
    { "type": "scrape" }
  ],
  "formats": ["markdown", "links", "ariaSnapshot", "console", "errors", "network"],
  "keepSession": true
}
```

**Targets** follow playwright.dev locator best practices — prefer
`{"getBy":"role|text|label|placeholder|altText|title|testId", ...}` or
`"role=button[name='Save']"` / `"text=Foo"` over brittle CSS. Modifiers:
`nth`, `first`, `last`, `hasText`, `has`, `hasNot`, `visible`, `frame`.
Strict mode is enforced — a locator matching multiple elements fails unless
disambiguated.

**Actions** — navigation: `goto`, `goBack`, `goForward`, `reload` · waits:
`wait`, `waitForSelector`, `waitForLoadState`, `waitForURL`,
`waitForFunction`, `waitForRequest`, `waitForResponse`, `waitForPopup`,
`waitForDownload` · input: `click`, `dblclick`, `rightClick`, `hover`, `tap`,
`fill`, `type`, `press`, `insertText`, `check`, `uncheck`, `setChecked`,
`selectOption`, `setInputFiles` (base64 files), `dragAndDrop`, `focus`,
`blur`, `scrollIntoView`, `scroll`, `wheel`, `mouseMove/Click/Down/Up`,
`touchTap` · capture: `scrape`, `screenshot` (clip/mask/quality/
omitBackground/animations), `pdf` (chromium), `text`, `innerText`,
`innerHTML`, `inputValue`, `attribute`, `count`, `ariaSnapshot`, `evaluate`,
`is*` family · assertions (web-first, polled): `assert` with
`toBeVisible/Hidden/Enabled/Disabled/Checked/Focused/Empty`,
`toHaveText/ContainText/Value/Attribute/CSS/Class/Id/Count/URL/Title` ·
dialogs/downloads/tabs: `dialog` (accept/dismiss), `download` (trigger +
capture), `newTab`, `switchTab`, `closeTab` · state: `getCookies`,
`setCookies`, `clearCookies`, `storageState` (export/import), localStorage
and sessionStorage get/set/clear, `grantPermissions`, `setGeolocation`,
`setOffline`, `setExtraHTTPHeaders`, `emulateMedia`, `setViewportSize`,
`setContent`, `addInitScript`, `addScriptTag`, `addStyleTag`, clipboard
read/write · network: `route` (abort/fulfill/mock/rewrite), `unroute`,
`blockResources`, `apiRequest` · observability: `startTracing`,
`stopTracing` (trace.zip artifact), `recordVideo`/`recordHar` session
options, `cdp` (chromium DevTools protocol), `clock` (time mocking).

**Concurrent waits** — trigger actions accept `waitForResponse`,
`waitForRequest`, `waitForURL`, `expectPopup`, `expectDownload`,
`acceptDialog`, `dismissDialog` inline options (armed before the trigger
runs).

**Session options** (at creation or per-request without `sessionId`):
`browser` (chromium|firefox|webkit), `device` (any Playwright device
descriptor — also selects the engine), `viewport`, `screen`, `userAgent`,
`locale`, `timezoneId`, `geolocation` (auto-grants permission),
`permissions`, `colorScheme`, `reducedMotion`, `forcedColors`, `isMobile`,
`hasTouch`, `deviceScaleFactor`, `extraHTTPHeaders`, `httpCredentials`,
`offline`, `ignoreHTTPSErrors`, `bypassCSP`, `javaScriptEnabled`,
`acceptDownloads`, `serviceWorkers`, `storageState`, `baseURL`, `proxy`,
`recordVideo`, `recordHar`, `strictSelectors`, `launchArgs` (extra browser
launch arguments, e.g. `["--disable-http2"]`). If the initial navigation
fails and no `launchArgs` were given, the request is retried once on a
browser launched with `INTERACT_FALLBACK_LAUNCH_ARGS` — sessions that used
it report `usedFallbackArgs` in `GET /v1/interact/sessions`.

**Formats**: `markdown`, `html`, `rawHtml`, `links`, `screenshot`,
`screenshot@fullPage`, `pdf`, `ariaSnapshot`, `console`, `errors`,
`network`, `cookies`, `storageState`, `tabs`.

Responses include `actionsLog` (per-action status/results), `data`, and a
`sessionId` when `keepSession` is set. Sessions expire after
`INTERACT_SESSION_TTL_MS` idle (default 10 min) and are capped by
`INTERACT_MAX_SESSIONS` (default 10). Artifacts persist under
`./data/artifacts/` and are retrievable via
`GET /v1/interact/sessions/:id/artifacts/:name` or the `artifact` action.

## MCP interface

Streamable HTTP at `http://localhost:18081/mcp`. Example client config:

```json
{
  "mcpServers": {
    "firecrawl": { "url": "http://localhost:18081/mcp" }
  }
}
```

Tools: `firecrawl_scrape`, `firecrawl_batch_scrape`,
`firecrawl_batch_scrape_status`, `firecrawl_crawl`, `firecrawl_crawl_status`,
`firecrawl_crawl_cancel`, `firecrawl_map`, `firecrawl_search`,
`firecrawl_extract`, `firecrawl_extract_status`, `firecrawl_interact`,
`firecrawl_interact_sessions`, `firecrawl_interact_close_session`.

## Configuration

`.env` (gitignored) and `.env.example` carry the same commented key set —
keep them in sync. Notables:

- `POSTGRES_PASSWORD` — required.
- `GATEWAY_PORT` / `MCP_PORT` — published ports (18080 / 18081).
- `GATEWAY_API_KEY` — set to require `Authorization: Bearer <key>` on the
  REST interface (and the web console); the MCP server forwards it
  automatically.
- `OLLAMA_BASE_URL` / `OLLAMA_MODEL` / `OLLAMA_EMBEDDING_MODEL` —
  extraction/planning backend (default `llama3.1:8b`, already pulled in the
  shared Ollama). Larger models extract better.
- `SEARXNG_ENDPOINT` / `SEARXNG_ENGINES` / `SEARXNG_CATEGORIES` — search
  backend + tuning.
- `INTERACT_SESSION_TTL_MS` / `INTERACT_MAX_SESSIONS` — session lifecycle.
- `INTERACT_FALLBACK_LAUNCH_ARGS` — comma-separated browser launch args
  retried once when a page fails to load (default
  `--disable-http2,--disable-blink-features=AutomationControlled`, which
  helps with CDNs that reject headless HTTP/2).
- `NUM_WORKERS_PER_QUEUE`, `CRAWL_CONCURRENT_REQUESTS`,
  `MAX_CONCURRENT_JOBS`, `BROWSER_POOL_SIZE`, `BLOCK_MEDIA`,
  `HARNESS_STARTUP_TIMEOUT_MS`, `LOGGING_LEVEL` — upstream tuning.

## Notes & limits

- Same open-source limits as upstream self-hosted Firecrawl: no Firecrawl
  Cloud features (Agent, billing), `/search` quality depends on the SearXNG
  engines, and extraction quality depends on the local model.
- Upstream deprecated the async `/v1/extract` job API; the gateway
  implements a synchronous equivalent on top of `/v2/scrape` + Ollama, so
  `GET /v1/extract/:id` (job polling) is not meaningful here.
- Upstream `/v1/scrape` picks its cheap fetch engine whenever the page is
  fetchable, and that engine can't take screenshots or run `actions`
  (actions require upstream's commercial Fire Engine) — the response carries
  a `"may be partial"` warning and no `data.screenshot`. For reliable
  browser rendering/screenshots/PDF use `POST /v1/interact`.
- `api`, `interact`, and the queue infra are internal-only — the outside
  reaches them solely through `gateway` on `:18080` (plus MCP on `:18081`).
- `api` is capped at 4 CPU / 8 GB, `playwright-service` at 2 CPU / 4 GB
  (see `docker-compose.yaml`); raise or remove for heavier workloads.
