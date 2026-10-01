import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { capture, artifactBase64 } from "./capture.js";
import { resolveLocator, resolveScope, resolveFrame, urlMatcher, toRegExp, matchUrl } from "./selectors.js";

export const ACTION_TYPES = [
  // navigation
  "goto", "goBack", "goForward", "reload", "capture",
  // waiting
  "wait", "waitForSelector", "waitForLoadState", "waitForURL", "waitForFunction",
  "waitForRequest", "waitForResponse", "waitForPopup", "waitForDownload",
  // input
  "click", "dblclick", "rightClick", "hover", "tap", "fill", "write", "type",
  "press", "insertText", "check", "uncheck", "setChecked", "selectOption",
  "setInputFiles", "upload", "dragAndDrop", "focus", "blur", "scrollIntoView",
  "scroll", "wheel", "mouseMove", "mouseClick", "mouseDown", "mouseUp", "touchTap",
  // extraction
  "scrape", "screenshot", "pdf", "text", "innerText", "innerHTML", "inputValue",
  "attribute", "count", "ariaSnapshot", "evaluate", "executeJavascript",
  "isVisible", "isHidden", "isEnabled", "isDisabled", "isEditable", "isChecked",
  // assertions (web-first, polled)
  "assert",
  // dialogs & downloads
  "dialog", "download",
  // tabs
  "newTab", "switchTab", "closeTab",
  // context & state
  "getCookies", "setCookies", "clearCookies", "storageState",
  "getLocalStorage", "setLocalStorage", "clearLocalStorage",
  "getSessionStorage", "setSessionStorage", "clearSessionStorage",
  "grantPermissions", "clearPermissions", "setGeolocation", "setOffline",
  "setExtraHTTPHeaders", "emulateMedia", "setViewportSize", "setContent",
  "addInitScript", "addScriptTag", "addStyleTag",
  "clipboardRead", "clipboardWrite",
  // network
  "route", "unroute", "blockResources",
  // observability / debugging
  "startTracing", "stopTracing", "artifact", "cdp", "apiRequest", "clock",
];

const T = (action) => action.target ?? action.selector;
const DEFAULT_WAIT_TIMEOUT = 30000;

export async function runActions(
  session,
  actions,
  { formats = ["markdown"], stopOnFailure = true } = {}
) {
  const log = [];
  let data = null;

  for (const raw of actions) {
    const action = raw || {};
    const entry = { type: action.type, status: "ok" };
    log.push(entry);
    try {
      try {
        await exec(session, action, entry, formats);
      } catch (err) {
        // Strict-mode violation means the locator matched multiple elements;
        // for agent/manual plans retry once with the first match.
        if (!/strict mode violation/i.test(err?.message ?? "") || T(action) == null) throw err;
        const base = T(action);
        const t = typeof base === "string"
          ? { selector: base, first: true }
          : { ...base, first: true };
        await exec(session, { ...action, target: t }, entry, formats);
        entry.note = "retried with first() after strict-mode violation";
      }
      if (action.type === "scrape" || action.type === "capture") {
        data = await capture(session, formats);
      }
    } catch (err) {
      entry.status = "failed";
      entry.error = String(err?.message || err);
      if (action.stopOnFailure ?? stopOnFailure) throw { log, data, actionError: entry };
    }
  }

  if (!data) data = await capture(session, formats);
  return { log, data };
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------
async function exec(session, action, entry, formats) {
  const page = session.page;
  switch (action.type) {
    // ------------------------------------------------------------- navigation
    case "goto": {
      assertHttpUrl(action.url);
      await page.goto(action.url, {
        waitUntil: action.waitUntil || "domcontentloaded",
        timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT,
        referer: action.referer,
      });
      await settle(page);
      entry.result = page.url();
      break;
    }
    case "goBack": case "goForward": case "reload": {
      const res = await page[action.type]({
        waitUntil: action.waitUntil || "load",
        timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT,
      });
      await settle(page);
      entry.result = page.url();
      void res;
      break;
    }

    // ---------------------------------------------------------------- waiting
    case "wait":
      await page.waitForTimeout(Math.min(action.milliseconds ?? action.timeout ?? 1000, 120000));
      break;
    case "waitForSelector":
      await resolveLocator(page, T(action)).first().waitFor({
        state: action.state || "visible",
        timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT,
      });
      break;
    case "waitForLoadState":
      await page.waitForLoadState(action.state || "load", {
        timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT,
      });
      break;
    case "waitForURL":
      await page.waitForURL(urlMatcher(action.url), {
        waitUntil: action.waitUntil || "load",
        timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT,
      });
      break;
    case "waitForFunction":
      await page.waitForFunction(action.expression ?? action.script, action.arg, {
        polling: action.polling,
        timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT,
      });
      break;
    case "waitForRequest":
      entry.result = await waitForRequest(session, action);
      break;
    case "waitForResponse":
      entry.result = await waitForResponse(session, action);
      break;
    case "waitForPopup": {
      // New pages are auto-registered via the context "page" listener.
      const p = await session.context.waitForEvent("page", {
        timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT,
      });
      session.page = p;
      await p.waitForLoadState("domcontentloaded").catch(() => {});
      entry.result = { index: session.pages.indexOf(p), url: p.url() };
      break;
    }
    case "waitForDownload":
      entry.result = await waitForDownload(session, action);
      break;

    // ------------------------------------------------------------------ input
    case "click": case "dblclick": case "rightClick":
      await doClick(session, action, entry);
      break;
    case "hover":
      await resolveLocator(page, T(action)).hover(locatorOpts(action, ["position", "modifiers", "force", "timeout"]));
      break;
    case "tap":
      await resolveLocator(page, T(action)).tap(locatorOpts(action, ["position", "modifiers", "force", "timeout", "trial"]));
      break;
    case "fill": case "write":
      await resolveLocator(page, T(action)).fill(
        String(action.value ?? action.text ?? ""),
        locatorOpts(action, ["force", "timeout"])
      );
      break;
    case "type":
      await resolveLocator(page, T(action)).pressSequentially(String(action.text ?? ""), {
        delay: action.delay,
        timeout: action.timeout,
      });
      break;
    case "press": {
      const waits = await withWaits(session, action, async () => {
        if (T(action)) await resolveLocator(page, T(action)).press(action.key, locatorOpts(action, ["delay", "timeout", "noWaitAfter"]));
        else await page.keyboard.press(action.key, { delay: action.delay });
      });
      if (Object.keys(waits).length) entry.result = waits;
      break;
    }
    case "insertText":
      await page.keyboard.insertText(String(action.text ?? ""));
      break;
    case "check": case "uncheck":
      await resolveLocator(page, T(action))[action.type === "check" ? "check" : "uncheck"](
        locatorOpts(action, ["force", "timeout", "trial"])
      );
      break;
    case "setChecked":
      await resolveLocator(page, T(action)).setChecked(!!action.checked, locatorOpts(action, ["force", "timeout"]));
      break;
    case "selectOption":
      entry.result = await resolveLocator(page, T(action)).selectOption(
        action.values ?? action.value ?? action.label ?? (action.index !== undefined ? { index: action.index } : action.labels ?? action.indexes),
        locatorOpts(action, ["force", "timeout"])
      );
      break;
    case "setInputFiles": case "upload": {
      const files = await normalizeFiles(action.files ?? []);
      await resolveLocator(page, T(action)).setInputFiles(files, locatorOpts(action, ["timeout"]));
      entry.result = { count: files.length };
      break;
    }
    case "dragAndDrop": {
      const source = resolveLocator(page, action.source);
      const target = resolveLocator(page, action.target);
      await source.dragTo(target, locatorOpts(action, ["force", "timeout", "sourcePosition", "targetPosition", "trial"]));
      break;
    }
    case "focus":
      await resolveLocator(page, T(action)).focus({ timeout: action.timeout });
      break;
    case "blur": {
      const loc = resolveLocator(page, T(action));
      if (loc.blur) await loc.blur();
      else await loc.evaluate((el) => el.blur());
      break;
    }
    case "scrollIntoView":
      await resolveLocator(page, T(action)).scrollIntoViewIfNeeded({ timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT });
      break;
    case "scroll": {
      if (T(action)) {
        await resolveLocator(page, T(action)).scrollIntoViewIfNeeded();
      } else {
        const amount = action.amount ?? 800;
        const [dx, dy] =
          action.direction === "up" ? [0, -amount]
          : action.direction === "left" ? [-amount, 0]
          : action.direction === "right" ? [amount, 0]
          : [0, amount];
        await page.mouse.wheel(action.deltaX ?? dx, action.deltaY ?? dy);
        await page.waitForTimeout(200);
      }
      break;
    }
    case "wheel":
      await page.mouse.wheel(action.deltaX ?? 0, action.deltaY ?? 0);
      break;
    case "mouseMove":
      await page.mouse.move(action.x, action.y, { steps: action.steps });
      break;
    case "mouseClick":
      await page.mouse.click(action.x, action.y, {
        button: action.button, clickCount: action.clickCount, delay: action.delay,
      });
      break;
    case "mouseDown":
      await page.mouse.down({ button: action.button, clickCount: action.clickCount });
      break;
    case "mouseUp":
      await page.mouse.up({ button: action.button, clickCount: action.clickCount });
      break;
    case "touchTap":
      if (action.x !== undefined) await page.touchscreen.tap(action.x, action.y);
      else await resolveLocator(page, T(action)).tap();
      break;

    // -------------------------------------------------------------- extraction
    case "scrape": case "capture":
      break; // handled by runActions -> capture()
    case "screenshot":
      entry.screenshot = (await screenshot(page, session, action)).toString("base64");
      break;
    case "pdf":
      ensureChromium(page, "pdf");
      entry.pdf = (await page.pdf(pdfOpts(action))).toString("base64");
      break;
    case "text":
      entry.result = await resolveLocator(page, T(action)).textContent({ timeout: action.timeout });
      break;
    case "innerText":
      entry.result = await resolveLocator(page, T(action)).innerText({ timeout: action.timeout });
      break;
    case "innerHTML":
      entry.result = await resolveLocator(page, T(action)).innerHTML({ timeout: action.timeout });
      break;
    case "inputValue":
      entry.result = await resolveLocator(page, T(action)).inputValue({ timeout: action.timeout });
      break;
    case "attribute":
      entry.result = await resolveLocator(page, T(action)).getAttribute(action.name, { timeout: action.timeout });
      break;
    case "count":
      entry.result = await resolveLocator(page, T(action)).count();
      break;
    case "ariaSnapshot":
      entry.result = await resolveLocator(page, T(action) ?? { selector: "body" }).ariaSnapshot({ timeout: action.timeout });
      break;
    case "evaluate": case "executeJavascript": {
      const scope = await resolveFrame(page, action.frame);
      const script = action.script ?? action.expression;
      // Playwright does not invoke string-valued functions: "() => x" would
      // evaluate to a function object and serialize as undefined. Compile
      // function-looking strings into a real function; plain expressions
      // (e.g. "document.title") are evaluated as-is.
      if (typeof script === "string" && /=>|^\s*function|^\s*\(\s*[^)]*\)\s*=>|^\s*async/.test(script)) {
        entry.result = await scope.evaluate(new Function(`"use strict"; return (${script});`)(), action.arg);
      } else {
        entry.result = await scope.evaluate(script, action.arg);
      }
      break;
    }
    case "isVisible": case "isHidden": case "isEnabled": case "isDisabled":
    case "isEditable": case "isChecked":
      entry.result = await resolveLocator(page, T(action))[action.type]();
      break;

    // -------------------------------------------------------------- assertion
    case "assert":
      entry.result = await runAssertions(session, action);
      if (entry.result.some((r) => !r.ok)) {
        const failed = entry.result.filter((r) => !r.ok);
        throw new Error(`assertion failed: ${failed.map((f) => `${f.type} (got ${JSON.stringify(f.actual)})`).join(", ")}`);
      }
      break;

    // ----------------------------------------------------- dialogs & downloads
    case "dialog":
      if (!["accept", "dismiss"].includes(action.action)) throw new Error('dialog.action must be "accept" or "dismiss"');
      session.dialogIntent = { action: action.action, promptText: action.promptText };
      entry.result = "armed";
      break;
    case "download": {
      if (!action.trigger) throw new Error("download requires a `trigger` action");
      entry.result = await doDownload(session, action);
      break;
    }

    // -------------------------------------------------------------------- tabs
    case "newTab": {
      const p = await session.context.newPage();
      registerPage(session, p);
      session.page = p;
      if (action.url) {
        assertHttpUrl(action.url);
        await p.goto(action.url, { waitUntil: action.waitUntil || "domcontentloaded", timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT });
        await settle(p);
      }
      entry.result = { index: session.pages.indexOf(p), url: p.url() };
      break;
    }
    case "switchTab": {
      const idx = await resolveTab(session, action);
      session.page = session.pages[idx];
      await session.page.bringToFront();
      entry.result = { index: idx, url: session.page.url() };
      break;
    }
    case "closeTab": {
      const idx = await resolveTab(session, action);
      const [p] = session.pages.splice(idx, 1);
      await p.close().catch(() => {});
      if (session.page === p || session.page.isClosed()) {
        session.page = session.pages[session.pages.length - 1];
        if (!session.page) {
          session.page = await session.context.newPage();
          registerPage(session, session.page);
        }
      }
      entry.result = { closed: idx };
      break;
    }

    // --------------------------------------------------------- context & state
    case "getCookies":
      entry.result = await session.context.cookies(action.urls);
      break;
    case "setCookies":
      await session.context.addCookies(action.cookies ?? []);
      break;
    case "clearCookies":
      await session.context.clearCookies(action.name || action.domain || action.path
        ? { name: action.name, domain: action.domain, path: action.path } : undefined);
      break;
    case "storageState":
      entry.result = await session.context.storageState(action.path ? { path: join(session.artifactDir, "storageState.json") } : undefined);
      break;
    case "getLocalStorage":
      entry.result = await page.evaluate((key) =>
        key ? localStorage.getItem(key) : { ...localStorage }, action.key);
      break;
    case "setLocalStorage":
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [action.key, String(action.value ?? "")]);
      break;
    case "clearLocalStorage":
      await page.evaluate(() => localStorage.clear());
      break;
    case "getSessionStorage":
      entry.result = await page.evaluate((key) =>
        key ? sessionStorage.getItem(key) : { ...sessionStorage }, action.key);
      break;
    case "setSessionStorage":
      await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [action.key, String(action.value ?? "")]);
      break;
    case "clearSessionStorage":
      await page.evaluate(() => sessionStorage.clear());
      break;
    case "grantPermissions":
      await session.context.grantPermissions(action.permissions ?? [], { origin: action.origin });
      break;
    case "clearPermissions":
      await session.context.clearPermissions();
      break;
    case "setGeolocation":
      await session.context.setGeolocation({
        latitude: action.latitude ?? action.lat, longitude: action.longitude ?? action.lon,
        accuracy: action.accuracy,
      });
      break;
    case "setOffline":
      await session.context.setOffline(action.offline ?? true);
      break;
    case "setExtraHTTPHeaders":
      await page.setExtraHTTPHeaders(action.headers ?? {});
      break;
    case "emulateMedia": {
      // Only forward keys the caller set: undefined = leave as-is, null = reset
      // to system (JSON can express both distinctly).
      const o = {};
      for (const k of ["media", "colorScheme", "reducedMotion", "forcedColors", "contrast"]) {
        if (k in action) o[k] = action[k];
      }
      await page.emulateMedia(o);
      break;
    }
    case "setViewportSize":
      await page.setViewportSize({ width: action.width, height: action.height });
      break;
    case "setContent":
      await page.setContent(String(action.html ?? ""), {
        waitUntil: action.waitUntil || "load", timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT,
      });
      break;
    case "addInitScript":
      // Context-level: applies to every page/frame created afterwards.
      await session.context.addInitScript(action.script ?? { content: action.content });
      break;
    case "addScriptTag":
      entry.result = !!(await page.addScriptTag(tagOpts(action)));
      break;
    case "addStyleTag":
      entry.result = !!(await page.addStyleTag(tagOpts(action)));
      break;
    case "clipboardRead":
      entry.result = await page.evaluate(() => navigator.clipboard.readText());
      break;
    case "clipboardWrite":
      await page.evaluate((t) => navigator.clipboard.writeText(t), String(action.text ?? ""));
      break;

    // ---------------------------------------------------------------- network
    case "route":
      await addRoute(session, action);
      break;
    case "unroute":
      await session.context.unroute(urlMatcher(action.url ?? "**/*"));
      break;
    case "blockResources":
      await addRoute(session, {
        url: action.url ?? "**/*",
        action: "abort",
        resourceTypes: action.types ?? ["image", "media", "font", "stylesheet"],
      });
      break;

    // ------------------------------------------------- observability / debug
    case "startTracing":
      await session.context.tracing.start({
        name: action.name, title: action.title,
        screenshots: action.screenshots ?? true,
        snapshots: action.snapshots ?? true,
        sources: action.sources ?? true,
      });
      session.tracing = true;
      break;
    case "stopTracing": {
      const p = join(session.artifactDir, "trace.zip");
      await session.context.tracing.stop({ path: p });
      session.tracing = false;
      session.artifacts.trace = p;
      entry.result = { artifact: "trace", ...(await artifactBase64(p)) };
      break;
    }
    case "artifact": {
      const file = session.artifacts[action.name];
      entry.result = file ? await artifactBase64(file) : { error: `no artifact "${action.name}"` };
      break;
    }
    case "cdp": {
      ensureChromium(page, "cdp");
      const cdp = await session.context.newCDPSession(page);
      entry.result = await cdp.send(action.method, action.params ?? {});
      break;
    }
    case "apiRequest":
      entry.result = await apiRequest(session, action);
      break;
    case "clock":
      entry.result = await clockOp(page, action);
      break;

    default:
      entry.status = "skipped";
      entry.error = `unknown action type "${action.type}"`;
  }
}

// ---------------------------------------------------------------------------
// Click-ish actions with concurrent wait support
// ---------------------------------------------------------------------------
async function doClick(session, action, entry) {
  const loc = resolveLocator(session.page, T(action));
  const opts = locatorOpts(action, [
    "button", "clickCount", "delay", "modifiers", "position",
    "force", "timeout", "trial", "noWaitAfter",
  ]);
  let waits;
  if (action.type === "dblclick") {
    waits = await withWaits(session, action, () => loc.dblclick(opts));
  } else {
    if (action.type === "rightClick") opts.button = "right";
    waits = await withWaits(session, action, () => loc.click(opts));
  }
  if (Object.keys(waits).length) entry.result = waits;
}

/**
 * Arm concurrent waits (waitForResponse / waitForRequest / waitForURL /
 * expectPopup / expectDownload / navigation) around a trigger — this is the
 * playwright.dev "wait for the event, then trigger" pattern applied so the
 * two happen concurrently.
 */
async function withWaits(session, action, fn, { autoSettle = true } = {}) {
  const page = session.page;
  const timeout = action.timeout ?? DEFAULT_WAIT_TIMEOUT;
  const pending = [];

  const arm = (kind, p) =>
    pending.push(
      p.then((value) => ({ kind, value }))
       .catch((err) => ({ kind, error: String(err?.message || err) }))
    );

  if (action.waitForResponse) {
    arm("response", page.waitForResponse(urlMatcher(action.waitForResponse), { timeout }).then(summarizeResponse));
  }
  if (action.waitForRequest) {
    arm("request", page.waitForRequest(urlMatcher(action.waitForRequest), { timeout })
      .then((r) => ({ method: r.method(), url: r.url(), resourceType: r.resourceType() })));
  }
  if (action.waitForURL) {
    arm("url", page.waitForURL(urlMatcher(action.waitForURL), { waitUntil: action.waitUntil || "load", timeout }).then(() => page.url()));
  }
  if (action.expectPopup) {
    arm("popup", page.context().waitForEvent("page", { timeout }).then(async (p) => {
      session.page = p;
      await p.waitForLoadState("domcontentloaded").catch(() => {});
      return { index: session.pages.indexOf(p), url: p.url() };
    }));
  }
  if (action.expectDownload) {
    arm("download", page.waitForEvent("download", { timeout }).then((d) => persistDownload(session, d)));
  }
  if (action.acceptDialog || action.dismissDialog) {
    session.dialogIntent = {
      action: action.acceptDialog ? "accept" : "dismiss",
      promptText: action.dialogText,
    };
  }
  if (autoSettle) {
    arm("settle", page.waitForLoadState("load", { timeout: 10000 }));
  }

  const triggerPromise = fn(); // throws propagate below
  const results = await Promise.all([triggerPromise.then(() => null), Promise.all(pending)]);
  const out = {};
  for (const r of results[1]) {
    if (r.kind === "settle") continue;
    out[r.kind] = r.error !== undefined ? { error: r.error } : r.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Waits
// ---------------------------------------------------------------------------
async function waitForResponse(session, action) {
  const matcher = urlMatcher(action.url);
  const seen = session.network.find((n) => n.status !== undefined && match(matcher, n.url));
  if (seen) return { ...seen, cached: true };
  const r = await session.page.waitForResponse(matcher, { timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT });
  return summarizeResponse(r);
}

async function waitForRequest(session, action) {
  const matcher = urlMatcher(action.url);
  const seen = session.network.find((n) => match(matcher, n.url));
  if (seen) return { ...seen, cached: true };
  const r = await session.page.waitForRequest(matcher, { timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT });
  return { method: r.method(), url: r.url(), resourceType: r.resourceType(), postData: r.postData()?.slice(0, 2000) };
}

async function waitForDownload(session, action) {
  const last = session.downloads[session.downloads.length - 1];
  if (last && Date.now() - last.at < 30000 && !action.fresh) return last.info;
  const d = await session.page.waitForEvent("download", { timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT });
  return persistDownload(session, d);
}

async function persistDownload(session, download) {
  const filename = download.suggestedFilename();
  const dir = join(session.artifactDir, "downloads");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${Date.now()}-${filename}`);
  await download.saveAs(filePath);
  const info = { suggestedFilename: filename, path: filePath, url: download.url() };
  const { stat, readFile } = await import("node:fs/promises");
  const s = await stat(filePath);
  info.size = s.size;
  if (s.size <= 8 * 1024 * 1024) info.base64 = (await readFile(filePath)).toString("base64");
  session.downloads.push({ at: Date.now(), info });
  return info;
}

async function doDownload(session, action) {
  const timeout = action.timeout ?? DEFAULT_WAIT_TIMEOUT;
  const downloadPromise = session.page
    .waitForEvent("download", { timeout })
    .then((d) => persistDownload(session, d));
  await exec(session, action.trigger, { type: action.trigger.type, status: "ok" }, []);
  return downloadPromise;
}

// ---------------------------------------------------------------------------
// Network routing / API requests / CDP / clock
// ---------------------------------------------------------------------------
async function addRoute(session, action) {
  const matcher = urlMatcher(action.url ?? "**/*");
  const resourceTypes = action.resourceTypes;
  const times = action.times; // optional: auto-remove after N hits

  const handler = async (route) => {
    const req = route.request();
    if (resourceTypes && !resourceTypes.includes(req.resourceType())) return route.continue();
    switch (action.action ?? "abort") {
      case "abort":
        return route.abort(action.errorCode || "failed");
      case "fulfill": {
        const opts = {
          status: action.status ?? 200,
          contentType: action.contentType,
          headers: action.headers,
        };
        if (action.json !== undefined) opts.json = action.json;
        else if (action.body !== undefined) opts.body = String(action.body);
        return route.fulfill(opts);
      }
      case "continue": case "fallback": default:
        return route.continue({
          url: action.rewriteUrl, method: action.method,
          headers: action.headers, postData: action.postData,
        });
    }
  };

  await session.context.route(matcher, handler, times ? { times } : undefined);
  session.routes.push({ url: action.url ?? "**/*", action: action.action ?? "abort" });
}

async function apiRequest(session, action) {
  const res = await session.context.request.fetch(action.url, {
    method: action.method ?? "GET",
    headers: action.headers,
    params: action.params,
    data: action.data,
    form: action.form,
    multipart: action.multipart,
    timeout: action.timeout ?? DEFAULT_WAIT_TIMEOUT,
    maxRedirects: action.maxRedirects,
    failOnStatusCode: false,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 50000); }
  return { status: res.status(), statusText: res.statusText(), headers: res.headers(), body };
}

async function clockOp(page, action) {
  if (!page.clock) throw new Error("clock API not available in this playwright version");
  const time = action.time ? new Date(action.time) : undefined;
  switch (action.op ?? "install") {
    case "install":
      await page.clock.install(time ? { time } : undefined);
      if (time) await page.clock.setSystemTime(time);
      return { installed: true, time: time?.toISOString() };
    case "setSystemTime":
      await page.clock.setSystemTime(action.time ? new Date(action.time) : new Date());
      return { ok: true };
    case "runFor": case "tick": case "tickFor": case "fastForward": {
      const fn = page.clock.runFor ?? page.clock.fastForward ?? page.clock.tickFor;
      if (!fn) throw new Error("clock time-skipping not supported in this version");
      await fn.call(page.clock, action.milliseconds ?? action.ms ?? 1000);
      return { ok: true };
    }
    case "resume":
      await page.clock.resume();
      return { ok: true };
    case "pauseAt":
      await page.clock.pauseAt(new Date(action.time));
      return { ok: true };
    default:
      throw new Error(`unknown clock op "${action.op}"`);
  }
}

// ---------------------------------------------------------------------------
// Assertions — web-first style, polled until timeout
// ---------------------------------------------------------------------------
async function runAssertions(session, action) {
  const page = session.page;
  const timeout = action.timeout ?? 10000;
  const list = Array.isArray(action.assertions) ? action.assertions
    : [{ type: action.assertion, value: action.value, name: action.name }];
  const results = [];
  for (const a of list) {
    results.push(await pollAssertion(page, action, a, a.timeout ?? timeout));
  }
  return results;
}

async function pollAssertion(page, action, a, timeout) {
  const deadline = Date.now() + timeout;
  const target = T(action) ?? a.target;
  let last = null;
  for (;;) {
    try {
      const { pass, actual } = await checkAssertion(page, target, a);
      if (pass) return { type: a.type, ok: true, actual };
      last = actual;
    } catch (e) {
      last = String(e?.message || e);
    }
    if (Date.now() >= deadline) return { type: a.type, ok: false, actual: last };
    await page.waitForTimeout(100);
  }
}

async function checkAssertion(page, target, a) {
  const loc = target ? resolveLocator(page, target) : null;
  const eq = (x, y) => String(x) === String(y);
  const contains = (x, y) => String(x ?? "").includes(String(y));
  switch (a.type) {
    case "toBeVisible": return { pass: await loc.isVisible(), actual: "visible?" };
    case "toBeHidden": return { pass: !(await loc.isVisible().catch(() => false)), actual: "visible" };
    case "toBeAttached": case "toBePresent": {
      const n = await loc.count(); return { pass: n > 0, actual: n };
    }
    case "toBeDetached": { const n = await loc.count(); return { pass: n === 0, actual: n }; }
    case "toBeEnabled": return { pass: await loc.isEnabled(), actual: await loc.isDisabled() };
    case "toBeDisabled": return { pass: await loc.isDisabled(), actual: "enabled" };
    case "toBeEditable": return { pass: await loc.isEditable(), actual: "readonly" };
    case "toBeChecked": return { pass: await loc.isChecked(), actual: await loc.isChecked() };
    case "toBeFocused": {
      const actual = await loc.evaluate((el) => document.activeElement === el);
      return { pass: !!actual, actual };
    }
    case "toBeEmpty": {
      const v = await loc.inputValue().catch(async () => loc.textContent());
      return { pass: !v, actual: v };
    }
    case "toHaveText": {
      const actual = await loc.textContent();
      const vals = Array.isArray(a.value) ? a.value : [a.value];
      return { pass: vals.some((v) => eq(actual?.trim(), v)), actual };
    }
    case "toContainText": {
      const actual = await loc.textContent();
      return { pass: contains(actual, a.value), actual };
    }
    case "toHaveValue": {
      const actual = await loc.inputValue();
      return { pass: eq(actual, a.value), actual };
    }
    case "toHaveAttribute": {
      const actual = await loc.getAttribute(a.name);
      return { pass: a.value === undefined ? actual !== null : eq(actual, a.value), actual };
    }
    case "toHaveCSS": {
      const actual = await loc.evaluate((el, n) => getComputedStyle(el).getPropertyValue(n), a.name);
      return { pass: contains(actual, a.value), actual };
    }
    case "toHaveCount": {
      const actual = await loc.count();
      return { pass: actual === a.value, actual };
    }
    case "toHaveClass": {
      const actual = await loc.getAttribute("class");
      return { pass: contains(actual, a.value), actual };
    }
    case "toHaveId": {
      const actual = await loc.getAttribute("id");
      return { pass: eq(actual, a.value), actual };
    }
    case "toHaveURL": {
      const m = urlMatcher(a.value);
      return { pass: match(m, page.url()), actual: page.url() };
    }
    case "toHaveTitle": {
      const actual = await page.title();
      const m = toRegExp(a.value);
      return { pass: m ? m.test(actual) : contains(actual, a.value), actual };
    }
    default:
      throw new Error(`unknown assertion "${a.type}"`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function locatorOpts(action, keys) {
  const o = {};
  for (const k of keys) if (action[k] !== undefined) o[k] = action[k];
  if (o.timeout === undefined) o.timeout = DEFAULT_WAIT_TIMEOUT;
  return o;
}

async function screenshot(page, session, action) {
  // `type` is the action name here; callers use `imageType`/`format` for png|jpeg.
  const opts = {
    fullPage: action.fullPage,
    clip: action.clip,
    quality: action.quality,
    type: action.imageType ?? action.format ?? (action.quality ? "jpeg" : "png"),
    omitBackground: action.omitBackground,
    animations: action.animations ?? "disabled",
    caret: action.caret,
    scale: action.scale,
    timeout: action.timeout,
  };
  if (Array.isArray(action.mask)) {
    opts.mask = action.mask.map((m) => resolveLocator(page, m));
  }
  const target = T(action);
  if (target) {
    delete opts.clip; // locator screenshots don't take clip
    delete opts.fullPage;
    return resolveLocator(page, target).screenshot(opts);
  }
  return page.screenshot(opts);
}

function pdfOpts(action) {
  const o = {};
  for (const k of [
    "format", "width", "height", "scale", "landscape", "printBackground",
    "pageRanges", "preferCSSPageSize", "displayHeaderFooter",
    "headerTemplate", "footerTemplate", "outline", "tagged",
  ]) {
    if (action[k] !== undefined) o[k] = action[k];
  }
  if (action.margin) o.margin = action.margin;
  return o;
}

async function tagOpts(action) {
  const o = {};
  for (const k of ["url", "content", "type"]) if (action[k] !== undefined) o[k] = action[k];
  return o;
}

async function normalizeFiles(files) {
  const out = [];
  for (const f of files) {
    if (typeof f === "string") {
      out.push({ name: f.split("/").pop() || "file", mimeType: "application/octet-stream", buffer: Buffer.from(f, "base64") });
    } else {
      out.push({
        name: f.name || "file",
        mimeType: f.mimeType || "application/octet-stream",
        buffer: Buffer.from(f.base64 ?? f.buffer ?? "", "base64"),
      });
    }
  }
  return out;
}

async function resolveTab(session, action) {
  session.pages = session.pages.filter((p) => !p.isClosed());
  const pages = session.pages;
  if (action.index !== undefined) {
    const i = action.index < 0 ? pages.length + action.index : action.index;
    if (!pages[i]) throw new Error(`tab index ${action.index} not found`);
    return i;
  }
  if (action.url !== undefined) {
    const m = urlMatcher(action.url);
    const i = pages.findIndex((p) => match(m, p.url()));
    if (i === -1) throw new Error(`no tab matching url "${action.url}"`);
    return i;
  }
  if (action.title !== undefined) {
    for (let i = 0; i < pages.length; i++) {
      const t = await pages[i].title().catch(() => "");
      if (t.includes(action.title)) return i;
    }
    throw new Error(`no tab with title containing "${action.title}"`);
  }
  if (pages.length === 0) throw new Error("no open tabs");
  return pages.length - 1;
}

function match(matcher, url) {
  return matchUrl(matcher, url);
}

async function summarizeResponse(r) {
  let body;
  try {
    const t = await r.text();
    body = t.length > 5000 ? t.slice(0, 5000) + "…" : t;
    try { body = JSON.parse(t); } catch { /* keep text */ }
  } catch { /* no body */ }
  return {
    url: r.url(), status: r.status(), statusText: r.statusText(),
    headers: r.headers(), body,
  };
}

async function settle(page) {
  await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(250);
}

function ensureChromium(page, feature) {
  if (page.context().browser()?.browserType().name() !== "chromium") {
    throw new Error(`${feature} requires chromium`);
  }
}

export function registerPage(session, page) {
  if (session.pages.includes(page)) return;
  session.pages.push(page);
  page.setDefaultTimeout(session.defaultTimeout ?? 15000);
  const ev = (kind, text) => {
    session.events.push({ at: Date.now(), kind, text: String(text).slice(0, 500) });
    if (session.events.length > 500) session.events.shift();
  };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) ev("nav", frame.url());
  });
  page.on("console", (msg) => {
    session.console.push({ type: msg.type(), text: msg.text().slice(0, 2000), at: Date.now() });
    if (session.console.length > 500) session.console.shift();
    ev(`console.${msg.type()}`, msg.text());
  });
  page.on("pageerror", (err) => {
    session.errors.push({ message: String(err).slice(0, 2000), at: Date.now() });
    if (session.errors.length > 500) session.errors.shift();
    ev("pageerror", err.message ?? err);
  });
  page.on("requestfailed", (req) => {
    ev("reqfail", `${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "failed"}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) ev("http", `${res.status()} ${res.url()}`);
  });
  page.on("download", (dl) => ev("download", dl.suggestedFilename()));
  page.on("request", (req) => {
    const entry = { method: req.method(), url: req.url(), resourceType: req.resourceType(), at: Date.now() };
    session.network.push(entry);
    session._netMap ??= new Map();
    session._netMap.set(req, entry);
    if (session.network.length > 500) session.network.shift();
  });
  page.on("response", (res) => {
    const entry = session._netMap?.get(res.request());
    if (entry) entry.status = res.status();
  });
  page.on("dialog", async (d) => {
    const intent = session.dialogIntent;
    session.dialogs.push({ type: d.type(), message: d.message(), handled: intent?.action ?? "dismiss", at: Date.now() });
    ev("dialog", `${d.type()}: ${d.message()}`);
    session.dialogIntent = null;
    try {
      if (intent?.action === "accept") await d.accept(intent.promptText);
      else await d.dismiss();
    } catch { /* dialog already handled */ }
  });
  page.on("close", () => {
    session.pages = session.pages.filter((p) => p !== page);
  });
}

export function assertHttpUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (!/^https?:$/i.test(u.protocol)) {
    throw new Error(`Only http(s) URLs are allowed, got "${u.protocol}"`);
  }
  return u.toString();
}
