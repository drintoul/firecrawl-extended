import express from "express";
import crypto from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit, devices } from "playwright";
import { runActions, assertHttpUrl, registerPage } from "./actions.js";
import { capture, artifactBase64 } from "./capture.js";
import { planActions, summarizePage } from "./llm.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || "600000", 10);
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "10", 10);
const DEFAULT_TIMEOUT_MS = parseInt(process.env.DEFAULT_ACTION_TIMEOUT_MS || "15000", 10);
const ARTIFACT_ROOT = process.env.ARTIFACT_DIR || join(tmpdir(), "interact-artifacts");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "50mb" }));

// ---------------------------------------------------------------------------
// Browser processes (lazy, one per engine) + session pool
// ---------------------------------------------------------------------------
const ENGINES = { chromium, firefox, webkit };
// Comma-separated browser launch args retried automatically when the initial
// navigation fails (e.g. "--disable-http2,--disable-blink-features=AutomationControlled").
const FALLBACK_LAUNCH_ARGS = (process.env.INTERACT_FALLBACK_LAUNCH_ARGS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const browsers = new Map(); // engine -> Promise<Browser>
const sessions = new Map(); // id -> session

async function getBrowser(engine = "chromium", launchArgs = []) {
  // Sessions with custom launch args get their own browser instance.
  const key = launchArgs.length ? `${engine}#${launchArgs.join("\0")}` : engine;
  if (!browsers.has(key)) {
    const type = ENGINES[engine];
    if (!type) throw new Error(`unknown browser engine "${engine}" (chromium|firefox|webkit)`);
    browsers.set(
      key,
      type.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", ...launchArgs],
      }).catch((err) => {
        browsers.delete(key);
        throw err;
      })
    );
  }
  return browsers.get(key);
}

const CONTEXT_OPTION_KEYS = [
  "viewport", "screen", "userAgent", "locale", "timezoneId", "geolocation",
  "permissions", "colorScheme", "reducedMotion", "forcedColors", "contrast",
  "isMobile", "hasTouch", "deviceScaleFactor", "extraHTTPHeaders",
  "httpCredentials", "offline", "ignoreHTTPSErrors", "bypassCSP",
  "javaScriptEnabled", "acceptDownloads", "serviceWorkers", "baseURL",
  "recordVideo", "recordHar", "proxy", "strictSelectors", "storageState",
];

async function createSession(opts = {}) {
  if (sessions.size >= MAX_SESSIONS) {
    throw Object.assign(new Error("Max sessions reached"), { status: 429 });
  }
  // Build context options: device descriptor + explicit overrides.
  const ctxOpts = {};
  let deviceEngine;
  if (opts.device) {
    const { defaultBrowserType, ...d } = devices[opts.device] || {};
    if (!d.viewport) throw new Error(`unknown device "${opts.device}" (see playwright.dev device descriptors)`);
    Object.assign(ctxOpts, d);
    deviceEngine = defaultBrowserType;
  }
  const engine = opts.browser || opts.engine || deviceEngine || "chromium";
  const launchArgs = Array.isArray(opts.launchArgs) ? opts.launchArgs.filter((a) => typeof a === "string") : [];
  const browser = await getBrowser(engine, launchArgs);

  for (const k of CONTEXT_OPTION_KEYS) {
    if (opts[k] !== undefined) ctxOpts[k] = opts[k];
  }
  // Aliases kept for convenience
  if (opts.headers && !ctxOpts.extraHTTPHeaders) ctxOpts.extraHTTPHeaders = opts.headers;
  if (ctxOpts.acceptDownloads === undefined) ctxOpts.acceptDownloads = true;
  if (ctxOpts.ignoreHTTPSErrors === undefined) ctxOpts.ignoreHTTPSErrors = true;
  if (ctxOpts.javaScriptEnabled === undefined) ctxOpts.javaScriptEnabled = true;
  if (ctxOpts.viewport === undefined && !opts.device) ctxOpts.viewport = { width: 1280, height: 800 };
  // Geolocation requires the matching permission (playwright.dev/docs/emulation)
  if (ctxOpts.geolocation && !(ctxOpts.permissions || []).includes("geolocation")) {
    ctxOpts.permissions = [...(ctxOpts.permissions || []), "geolocation"];
  }
  if (ctxOpts.isMobile && engine !== "chromium") {
    delete ctxOpts.isMobile; // isMobile is chromium-only
  }

  // Recording artifacts land in a per-session directory.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(ARTIFACT_ROOT, { recursive: true });
  const artifactDir = await mkdtemp(join(ARTIFACT_ROOT, "session-"));
  if (ctxOpts.recordVideo) {
    ctxOpts.recordVideo = {
      dir: artifactDir,
      size: ctxOpts.recordVideo.size ?? { width: 1280, height: 800 },
    };
  }
  if (ctxOpts.recordHar) {
    ctxOpts.recordHar = {
      path: join(artifactDir, "session.har"),
      urlFilter: ctxOpts.recordHar.urlFilter,
      mode: ctxOpts.recordHar.mode,
      content: ctxOpts.recordHar.content,
    };
  }
  // storageState may be given as an object or a base64 JSON blob
  if (typeof ctxOpts.storageState === "string") {
    try {
      ctxOpts.storageState = JSON.parse(Buffer.from(ctxOpts.storageState, "base64").toString("utf8"));
    } catch {
      // assume it's a raw JSON string
      try { ctxOpts.storageState = JSON.parse(ctxOpts.storageState); } catch { /* leave as-is */ }
    }
  }

  const id = crypto.randomUUID();
  const session = {
    id, context: null, browser: engine,
    page: null, pages: [],
    console: [], errors: [], network: [], dialogs: [], downloads: [],
    routes: [], artifacts: {}, artifactDir,
    dialogIntent: null, tracing: false,
    defaultTimeout: opts.defaultTimeout ?? DEFAULT_TIMEOUT_MS,
    opts,
    lastUsed: Date.now(), createdAt: Date.now(),
  };

  const spawnContext = async (br) => {
    const context = await br.newContext(ctxOpts);
    // Auto-register every page/popup the context spawns.
    context.on("page", (p) => registerPage(session, p));
    context.on("close", () => { if (session.context === context) sessions.delete(id); });
    const page = await context.newPage();
    session.context = context;
    session.pages = [];
    registerPage(session, page);
    session.page = page;
  };
  await spawnContext(browser);

  sessions.set(id, session);

  if (opts.url) {
    assertHttpUrl(opts.url);
    const nav = { waitUntil: opts.waitUntil || "domcontentloaded", timeout: opts.timeout ?? 30000 };
    try {
      await session.page.goto(opts.url, nav);
    } catch (err) {
      if (launchArgs.length || !FALLBACK_LAUNCH_ARGS.length) {
        sessions.delete(id);
        await session.context.close().catch(() => {});
        throw err;
      }
      // Retry once on a browser launched with the fallback args.
      const fbBrowser = await getBrowser(engine, FALLBACK_LAUNCH_ARGS);
      const oldCtx = session.context;
      session.context = null; // keep the close handler from deleting the session
      await oldCtx.close().catch(() => {});
      await spawnContext(fbBrowser);
      session.usedFallbackArgs = true;
      try {
        await session.page.goto(opts.url, nav);
      } catch (err2) {
        sessions.delete(id);
        await session.context.close().catch(() => {});
        throw err2;
      }
    }
  }
  return session;
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  sessions.delete(id);
  // Finalize artifacts (video/har materialize on context.close)
  await s.context.close().catch(() => {});
  const artifacts = {};
  if (s.artifacts.trace) artifacts.trace = s.artifacts.trace;
  return artifacts;
}

// TTL sweeper
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) closeSession(id);
  }
}, 30000).unref();

// ---------------------------------------------------------------------------
// Routes — the gateway exposes these at /v1/interact/*
// ---------------------------------------------------------------------------
app.get("/healthz", (_req, res) => res.json({ status: "ok", sessions: sessions.size }));

app.get(["/v1/interact/sessions", "/v2/interact/sessions"], (_req, res) => {
  res.json({
    success: true,
    sessions: [...sessions.values()].map((s) => ({
      id: s.id,
      browser: s.browser,
      usedFallbackArgs: !!s.usedFallbackArgs,
      url: s.page?.url(),
      tabs: s.pages.length,
      createdAt: new Date(s.createdAt).toISOString(),
      lastUsed: new Date(s.lastUsed).toISOString(),
    })),
  });
});

app.post(["/v1/interact/sessions", "/v2/interact/sessions"], async (req, res) => {
  try {
    const session = await createSession(req.body || {});
    res.json({ success: true, sessionId: session.id, browser: session.browser });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: String(err.message || err) });
  }
});

app.delete(["/v1/interact/sessions/:id", "/v2/interact/sessions/:id"], async (req, res) => {
  const artifacts = await closeSession(req.params.id);
  if (!artifacts) return res.status(404).json({ success: false, error: "session not found" });
  res.json({ success: true, artifacts: Object.keys(artifacts) });
});

app.get(["/v1/interact/sessions/:id/artifacts/:name", "/v2/interact/sessions/:id/artifacts/:name"], async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ success: false, error: "session not found" });
  let file = s.artifacts[req.params.name] ||
    (req.params.name === "har" ? join(s.artifactDir, "session.har") : null);
  if (!file && req.params.name === "video") {
    file = await s.page?.video()?.path().catch(() => null);
  }
  if (!file) return res.status(404).json({ success: false, error: `no artifact "${req.params.name}"` });
  const r = await artifactBase64(file);
  if (!r) return res.status(404).json({ success: false, error: "artifact file not found" });
  res.json({ success: true, ...r });
});

/**
 * POST /v1/interact — run an action plan (or an Ollama-planned `prompt`)
 * against a Playwright session.
 *
 * Body: {
 *   url?, sessionId?, keepSession?, actions?, prompt?,
 *   formats?, timeout?, stopOnFailure?,
 *   // session creation options (only when a new session is created):
 *   browser, device, viewport, headers/extraHTTPHeaders, userAgent, locale,
 *   timezoneId, geolocation, permissions, colorScheme, offline, httpCredentials,
 *   bypassCSP, javaScriptEnabled, acceptDownloads, serviceWorkers, storageState,
 *   recordVideo, recordHar, proxy, waitUntil, launchArgs
 *   (if goto fails and launchArgs wasn't set, retries once with
 *    INTERACT_FALLBACK_LAUNCH_ARGS)
 * }
 */
app.post(["/v1/interact", "/v2/interact"], async (req, res) => {
  const body = req.body || {};
  const {
    url, sessionId, keepSession = false, prompt,
    formats = ["markdown"], stopOnFailure = true,
  } = body;
  let actions = Array.isArray(body.actions) ? body.actions : null;

  if (!actions && !prompt) {
    return res.status(400).json({ success: false, error: "Provide `actions` or `prompt`." });
  }
  if (!sessionId && !url && !body.setContent) {
    return res.status(400).json({ success: false, error: "Provide `url` or `sessionId`." });
  }

  let sid = sessionId;
  let session = sid ? sessions.get(sid) : null;
  if (sid && !session) {
    return res.status(404).json({ success: false, error: `Session ${sid} not found` });
  }

  let ownSession = false;
  try {
    if (!session) {
      session = await createSession(body);
      sid = session.id;
      ownSession = true;
      if (body.setContent && !url) {
        await session.page.setContent(String(body.setContent), { waitUntil: "load" });
      }
    }
    session.lastUsed = Date.now();
    session.console.length = 0;
    session.errors.length = 0;

    if (!actions && prompt) {
      const summary = await summarizePage(session.page);
      actions = await planActions(prompt, summary);
    }

    const timeout = Math.min(body.timeout ?? 120000, 600000);
    const result = await withTimeout(
      runActions(session, actions, { formats, stopOnFailure }),
      timeout
    );

    if (!keepSession && ownSession) {
      await closeSession(sid);
      sid = null;
    }

    res.json({
      success: true,
      sessionId: sid,
      plannedActions: prompt && !body.actions ? actions : undefined,
      actionsLog: result.log,
      data: result.data,
    });
  } catch (err) {
    if (ownSession && !keepSession) await closeSession(sid);
    if (err && err.actionError) {
      return res.status(422).json({
        success: false,
        sessionId: keepSession ? sid : null,
        error: err.actionError.error,
        failedAction: err.actionError,
        actionsLog: err.log,
        data: err.data,
      });
    }
    res.status(err.status || 500).json({ success: false, error: String(err.message || err) });
  }
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`interact timed out after ${ms}ms`)), ms)
    ),
  ]);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`interact service listening on :${PORT} (ttl=${SESSION_TTL_MS}ms, max=${MAX_SESSIONS}, engines=${Object.keys(ENGINES).join(",")})`);
});
