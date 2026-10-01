import express from "express";
import crypto from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit, devices } from "playwright";
import { runActions, assertHttpUrl, registerPage } from "./actions.js";
import { capture, artifactBase64 } from "./capture.js";
import { agentStep, summarizePage, describeVisual } from "./llm.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || "600000", 10);
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "10", 10);
const DEFAULT_TIMEOUT_MS = parseInt(process.env.DEFAULT_ACTION_TIMEOUT_MS || "15000", 10);
const ARTIFACT_ROOT = process.env.ARTIFACT_DIR || join(tmpdir(), "interact-artifacts");
// Vision model used to describe page screenshots during prompt-mode agent
// steps (e.g. a VLM like qwen2.5vl). Set to "" to disable; per-request
// `vision: false` or `vision: "<model>"` overrides.
const VISION_MODEL = process.env.INTERACT_VISION_MODEL || "";

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
const jobs = new Map();     // id -> async interact job
const JOB_TTL_MS = parseInt(process.env.JOB_TTL_MS || "600000", 10);

// Tracker/ad domains aborted when `adblock` is enabled for a session
// (env default via INTERACT_ADBLOCK). Cuts noise + speeds heavy pages.
const AD_HOSTS_RE = /doubleclick\.net|googletagmanager\.com|google-analytics\.com|analytics\.google\.com|googlesyndication\.com|facebook\.net|connect\.facebook\.net|analytics\.tiktok\.com|px\.ads\.linkedin\.com|amazon-adsystem\.com|scorecardresearch\.com|quantserve\.com|adnxs\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|clarity\.ms|hotjar\.com|ads\.linkedin\.com|bat\.bing\.com|snap\.licdn\.com|demdex\.net|moatads\.com|ads\.twitter\.com|adservice\.google/i;
const ADBLOCK_DEFAULT = /^(1|true)$/i.test(process.env.INTERACT_ADBLOCK || "");

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
    events: [],
    routes: [], artifacts: {}, artifactDir,
    dialogIntent: null, tracing: false,
    defaultTimeout: opts.defaultTimeout ?? DEFAULT_TIMEOUT_MS,
    opts,
    lastUsed: Date.now(), createdAt: Date.now(),
  };

  const spawnContext = async (br) => {
    const context = await br.newContext(ctxOpts);
    if (opts.adblock ?? ADBLOCK_DEFAULT) {
      await context.route(AD_HOSTS_RE, (route) => route.abort());
    }
    // Auto-register every page/popup the context spawns.
    context.on("page", (p) => registerPage(session, p));
    context.on("close", () => { if (session.context === context) sessions.delete(id); });
    session.pages = [];
    const page = await context.newPage();
    session.context = context;
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

async function writeEventsLog(s) {
  const file = join(s.artifactDir, "events.jsonl");
  await writeFile(file, s.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  s.artifacts.events = file;
  return file;
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  sessions.delete(id);
  // Finalize artifacts (video/har materialize on context.close)
  await s.context.close().catch(() => {});
  // Persist the browser event timeline for post-mortem/debugging.
  await writeEventsLog(s).catch(() => {});
  return { ...s.artifacts };
}

// TTL sweeper
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) closeSession(id);
  }
  for (const [id, j] of jobs) {
    if (j.finishedAt && now - j.finishedAt > JOB_TTL_MS) jobs.delete(id);
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
  if (!file && req.params.name === "events") {
    file = await writeEventsLog(s).catch(() => null);
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
/**
 * Run an interact request end-to-end. Returns { httpStatus, payload } —
 * never writes to a response, so both the sync route and async jobs share it.
 * `live` (optional) is populated with live references for job polling:
 *   live.sessionId, live.events, live.actionsLog, live.transcript
 */
async function runInteract(body, live) {
  const {
    url, sessionId, keepSession = false, prompt,
    formats = ["markdown"], stopOnFailure = true,
  } = body;
  let actions = Array.isArray(body.actions) ? body.actions : null;

  if (!actions && !prompt) {
    return { httpStatus: 400, payload: { success: false, error: "Provide `actions` or `prompt`." } };
  }
  if (!sessionId && !url && !body.setContent) {
    return { httpStatus: 400, payload: { success: false, error: "Provide `url` or `sessionId`." } };
  }

  let sid = sessionId;
  let session = sid ? sessions.get(sid) : null;
  if (sid && !session) {
    return { httpStatus: 404, payload: { success: false, error: `Session ${sid} not found` } };
  }

  let ownSession = false;
  let evStart = 0;
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
    evStart = ownSession ? 0 : session.events.length;

    const timeout = Math.min(body.timeout ?? (prompt ? 300000 : 120000), 600000);
    const deadline = Date.now() + timeout;
    const remaining = () => Math.max(2000, deadline - Date.now());

    let result = { log: [], data: null };
    let answer = null;
    const transcript = [];
    if (live) {
      live.sessionId = session.id;
      live.events = session.events;
      live.actionsLog = result.log;
      live.transcript = transcript;
    }

    if (!actions && prompt) {
      // Agent loop: observe → plan → act → repeat until the model answers
      // or maxSteps is hit. Each step sees the page text + element snapshot.
      const maxSteps = Math.min(body.maxSteps ?? 5, 12);
      const visionModel = body.vision === false ? null
        : typeof body.vision === "string" ? body.vision
        : VISION_MODEL || null;
      actions = [];
      for (let step = 0; step < maxSteps; step++) {
        let summary = await withTimeout(summarizePage(session.page), Math.min(15000, remaining()));
        if (visionModel) {
          try {
            const visual = await withTimeout(
              describeVisual(session.page, visionModel),
              Math.min(60000, remaining())
            );
            if (visual) summary += `\n\nvisual description of the page:\n${visual}`;
          } catch { /* vision best-effort */ }
        }
        const next = await withTimeout(agentStep(prompt, transcript, summary, body.model), Math.min(180000, remaining()));
        if (next.done) {
          answer = next.answer;
          session.events.push({ at: Date.now(), kind: "agent", text: `done: ${answer.slice(0, 300)}` });
          break;
        }
        if (!next.actions?.length) {
          session.events.push({ at: Date.now(), kind: "agent", text: `step ${step + 1}: model returned no actions` });
          break;
        }
        // Agent steps shouldn't wait long — if an element isn't there in
        // 10s the plan is wrong, and the model needs the feedback fast.
        for (const a of next.actions) {
          if (a.timeout == null && a.type !== "goto") a.timeout = 10000;
        }
        session.events.push({ at: Date.now(), kind: "agent", text: `step ${step + 1}: ${next.actions.map((a) => a.type).join(" → ")}` });
        actions.push(...next.actions);
        let stepRes;
        try {
          stepRes = await withTimeout(
            runActions(session, next.actions, { formats: [], stopOnFailure: false }),
            remaining()
          );
        } catch (e) {
          transcript.push(`actions failed: ${String(e.message ?? e).split("\n")[0].slice(0, 150)}`);
          break;
        }
        result.log.push(...stepRes.log);
        for (const a of stepRes.log) {
          const st = a.error ? `failed — ${String(a.error).split("\n")[0].slice(0, 150)}` : (a.status ?? "ok");
          transcript.push(`${a.type}: ${st}${a.result ? ` → ${String(a.result).slice(0, 120)}` : ""}`);
        }
        transcript.push(`(now on ${session.page.url()})`);
        // Loop guard: nudge the model when it repeats the same failure.
        const failed = transcript.filter((t) => /: failed/.test(t));
        if (failed.length >= 2 && failed.slice(-2).every((t) => t.startsWith(failed.at(-1).split(":")[0]))) {
          transcript.push("(the last action keeps failing — try a different approach: goto a URL from the snapshot, scroll, or finish with done)");
        }
      }
      if (formats.length) {
        try {
          const cap = await withTimeout(
            runActions(session, [{ type: "scrape" }], { formats, stopOnFailure: false }),
            remaining()
          );
          result.log.push(...cap.log);
          result.data = cap.data;
        } catch { /* capture best-effort */ }
      }
    } else {
      result = await withTimeout(
        runActions(session, actions, { formats, stopOnFailure }),
        remaining()
      );
    }

    if (!keepSession && ownSession) {
      await closeSession(sid);
      sid = null;
    }

    return {
      httpStatus: 200,
      payload: {
        success: true,
        sessionId: sid,
        plannedActions: prompt && !body.actions ? actions : undefined,
        answer,
        transcript,
        actionsLog: result.log,
        events: session.events.slice(evStart),
        data: result.data,
      },
    };
  } catch (err) {
    if (ownSession && !keepSession) await closeSession(sid);
    if (err && err.actionError) {
      return {
        httpStatus: 422,
        payload: {
          success: false,
          sessionId: keepSession ? sid : null,
          error: err.actionError.error,
          failedAction: err.actionError,
          plannedActions: prompt && !body.actions ? actions : undefined,
          actionsLog: err.log,
          events: session?.events.slice(evStart ?? 0),
          data: err.data,
        },
      };
    }
    return {
      httpStatus: err.status || 500,
      payload: { success: false, error: String(err.message || err) },
    };
  }
}

app.post(["/v1/interact", "/v2/interact"], async (req, res) => {
  const { httpStatus, payload } = await runInteract(req.body || {});
  res.status(httpStatus).json(payload);
});

/**
 * POST /v1/interact/async — same body as /v1/interact; returns a job id.
 * GET  /v1/interact/jobs/:id — live events/actionsLog while running.
 */
app.post(["/v1/interact/async", "/v2/interact/async"], (req, res) => {
  const body = req.body || {};
  if (!body.actions && !body.prompt) {
    return res.status(400).json({ success: false, error: "Provide `actions` or `prompt`." });
  }
  if (!body.sessionId && !body.url && !body.setContent) {
    return res.status(400).json({ success: false, error: "Provide `url` or `sessionId`." });
  }
  const id = crypto.randomUUID();
  const job = {
    id, status: "running", createdAt: Date.now(),
    events: [], actionsLog: [], transcript: [],
    answer: null, data: null, error: null, finishedAt: null,
  };
  jobs.set(id, job);
  runInteract(body, job)
    .then(({ payload }) => {
      job.status = payload.success ? "completed" : "failed";
      job.answer = payload.answer ?? null;
      job.transcript = payload.transcript ?? job.transcript;
      job.actionsLog = payload.actionsLog ?? job.actionsLog;
      job.data = payload.data ?? null;
      job.error = payload.error ?? null;
      job.failedAction = payload.failedAction;
      job.plannedActions = payload.plannedActions;
      job.sessionId = payload.sessionId;
      job.finishedAt = Date.now();
    })
    .catch((e) => {
      job.status = "failed";
      job.error = String(e?.payload?.error ?? e?.message ?? e);
      job.finishedAt = Date.now();
    });
  res.status(202).json({ success: true, id, status: "running", statusUrl: `/v1/interact/jobs/${id}` });
});

app.get(["/v1/interact/jobs/:id", "/v2/interact/jobs/:id"], (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "job not found" });
  res.json({ success: true, ...job });
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
