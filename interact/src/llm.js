import { ACTION_TYPES } from "./actions.js";

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://ollama:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";
// keep_alive keeps the model resident between planning calls so big models
// don't pay a cold-load on every agent step ("-1" = never unload).
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? "30m";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 180000);

const SYSTEM_PROMPT = `You convert a natural-language instruction into a JSON plan of browser actions for Playwright.

Reply with ONLY a JSON object: {"actions": [...]} — no prose, no markdown fences.

Every action has a "type". Useful types:

Navigation/wait:
- {"type":"goto","url":"https://..."}
- {"type":"wait","milliseconds":1000}
- {"type":"waitForSelector","target":<target>,"state":"visible"}
- {"type":"waitForURL","url":"*/dashboard*"}
- {"type":"waitForLoadState","state":"networkidle"}

Input — actions that operate on an element take "target", which may be:
  a real CSS selector for THIS page: "#search-input", "nav a", "button.submit"
  or a Playwright locator: "text=Foo" | "role=button[name='Save']"
  or an object: {"getBy":"role","role":"button","name":"Save"},
  {"getBy":"label","value":"Email"}, {"getBy":"placeholder","value":"Search"},
  {"getBy":"text","value":"..."}, {"getBy":"testId","value":"..."},
  {"selector":"css","nth":0}, {"selector":"css","hasText":"..."}
- {"type":"click","target":<target>,"waitForURL":"*/next*"}  // optional: waitForResponse, expectPopup, expectDownload, acceptDialog
- {"type":"fill","target":<target>,"text":"what to type"}
- {"type":"type","target":<target>,"text":"keystrokes","delay":50}
- {"type":"press","key":"Enter","target":<target>}
- {"type":"check"|"uncheck","target":<target>}
- {"type":"selectOption","target":<target>,"label":"Option"}
- {"type":"scroll","direction":"down","amount":800} or {"type":"scrollIntoView","target":<target>}
- {"type":"hover","target":<target>}

Capture/extract:
- {"type":"scrape"}                 — capture page per requested formats (end plans with this)
- {"type":"screenshot","fullPage":true}
- {"type":"text"|"innerText","target":<target>}
- {"type":"ariaSnapshot","target":{"selector":"main"}}
- {"type":"evaluate","script":"() => document.title"}

Assertions (polled, web-first):
- {"type":"assert","target":<target>,"assertions":[{"type":"toBeVisible"},{"type":"toContainText","value":"Welcome"}]}

Rules:
- Prefer getBy/role/text locators over brittle CSS (playwright.dev best practice).
- Targets must be REAL selectors derived from the page snapshot or task — NEVER emit placeholder words like "css selector", "selector", or "<target>".
- If nothing specific must be waited for, use {"type":"waitForLoadState","state":"load"} or {"type":"wait","milliseconds":2000} — not waitForSelector with a made-up selector. Never use "networkidle" — ad/analytics requests prevent it on modern sites.
- For "find/read/report" instructions, a short plan is enough: goto → waitForLoadState → scrape. The scrape captures the page content for the answer.
- Keep plans under 15 actions. Do not invent credentials or personal data.
- End the plan with {"type":"scrape"} so the final page state is captured.`;

const AGENT_SYSTEM_PROMPT = `You drive a web browser via Playwright actions to satisfy an instruction, step by step.

Reply with ONLY a JSON object — no prose, no markdown fences. Either:

{"actions": [...]} — the next few browser actions to take (1-5), OR
{"done": true, "answer": "..."} — when the page content answers the instruction, or you determine it cannot be answered.

Action vocabulary:
- {"type":"goto","url":"https://..."}
- {"type":"wait","milliseconds":1500}
- {"type":"waitForLoadState","state":"load"}
- {"type":"waitForURL","url":"*/hawaii*"}
- {"type":"click","target":<target>}
- {"type":"fill","target":<target>,"text":"..."}
- {"type":"press","key":"Enter","target":<target>}
- {"type":"scroll","direction":"down","amount":800}
- {"type":"back"} — go back in history

A <target> is a REAL locator for THIS page — from the snapshot's interactive elements:
  "text=Exact Text" | "role=link[name='Hawaii']" | a CSS selector like "#nav a"
  or {"getBy":"role","role":"link","name":"Hawaii"} | {"getBy":"text","value":"Hawaii"}

Rules:
- Look at "Visible text" in the snapshot FIRST — the answer may already be there.
- For "which X does Y" / "find the X that Z" questions, go to the listing, category, destination, or search page that groups by Z — do NOT iterate individual item/detail pages hoping each mentions Z. Detail pages rarely say where an item is used.
- To reach content, prefer goto with an href from the interactive-elements list over clicking ambiguous nav text; copy hrefs exactly.
- Never invent selectors — every target must come from the snapshot or be a URL/text you saw.
- Never use waitForLoadState with "networkidle" — ad requests prevent it.
- waitForURL only waits — it does NOT navigate. To reach a page, use goto. Only emit waitForURL immediately after a click/goto in the SAME actions array.
- If a step failed, try a different target — don't repeat the same failing action.
- When you have enough information (or it's clear you can't get it), reply {"done":true,"answer":"..."} immediately.`;

/**
 * Ask Ollama to convert `prompt` (plus a compact description of the current
 * page) into an action list. Returns an array of validated actions.
 */
export async function planActions(prompt, pageSummary, model = OLLAMA_MODEL) {
  const user = [
    `Instruction: ${prompt}`,
    pageSummary ? `\nCurrent page snapshot:\n${pageSummary}` : "",
  ].join("\n");

  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      keep_alive: OLLAMA_KEEP_ALIVE,
      stream: false,
      format: "json",
      options: { temperature: 0 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama planning failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const body = await res.json();
  const content = body?.message?.content ?? "";
  const parsed = extractJson(content);
  const actions = Array.isArray(parsed) ? parsed : parsed?.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("Ollama returned no usable action plan");
  }
  const valid = sanitizeActions(actions);
  if (!valid.length) throw new Error("Ollama returned no usable action plan");
  return valid;
}

const PLACEHOLDER_TARGET = /^(css\s*selector|selector|target|element|<[^>]*>|\.\.\.)$/i;
const TARGET_REQUIRED = new Set([
  "click", "dblclick", "fill", "type", "press", "check", "uncheck",
  "selectOption", "scrollIntoView", "hover", "assert",
]);

function sanitizeActions(actions) {
  return actions
    .filter((a) => a && typeof a === "object" && ACTION_TYPES.includes(a.type))
    .map((a) => {
      if (a.type === "waitForLoadState" && a.state === "networkidle") a = { ...a, state: "load" };
      if ((a.type === "evaluate" || a.type === "executeJavascript") && a.script != null) {
        try { new Function(`"use strict"; return (${a.script});`); }
        catch { try { new Function(String(a.script)); } catch { return null; } }
      }
      const badTarget = a.target == null || a.target === "" ||
        (typeof a.target === "string" && PLACEHOLDER_TARGET.test(a.target.trim()));
      if (!badTarget) return a;
      if (a.type === "waitForSelector") return { type: "waitForLoadState", state: "load" };
      if (TARGET_REQUIRED.has(a.type)) return null;
      const { target, ...rest } = a;
      return rest;
    })
    .filter(Boolean)
    .slice(0, 25);
}

/**
 * One agent step: returns {done:true, answer} or {done:false, actions:[...]}.
 * `transcript` is a list of short strings describing what already happened.
 */
export async function agentStep(prompt, transcript, pageSummary, model = OLLAMA_MODEL) {
  const user = [
    `Instruction: ${prompt}`,
    pageSummary ? `\nCurrent page snapshot:\n${pageSummary}` : "",
    `\nProgress so far:\n${transcript.length ? transcript.join("\n") : "(nothing yet)"}`,
  ].join("\n");

  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      keep_alive: OLLAMA_KEEP_ALIVE,
      stream: false,
      format: "json",
      options: { temperature: 0 },
      messages: [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama planning failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const content = body?.message?.content ?? "";
  let parsed;
  try {
    parsed = extractJson(content);
  } catch {
    console.warn("agentStep: unparseable model output:", content.slice(0, 300));
    return { done: false, actions: [] };
  }
  if (parsed?.done) return { done: true, answer: String(parsed.answer ?? "") };
  const actions = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.actions) ? parsed.actions
    : parsed?.type ? [parsed] : null;
  if (!Array.isArray(actions)) {
    console.warn("agentStep: no actions in model output:", content.slice(0, 300));
    return { done: false, actions: [] };
  }
  return { done: false, actions: sanitizeActions(actions).slice(0, 8) };
}

/** Ask a vision model to describe the current page screenshot. */
export async function describeVisual(page, model) {
  if (!model) return "";
  const shot = await page.screenshot({ type: "jpeg", quality: 55 });
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      keep_alive: OLLAMA_KEEP_ALIVE,
      stream: false,
      options: { temperature: 0 },
      messages: [{
        role: "user",
        content: "Describe what is visibly on this web page screenshot: cookie/consent banners or modals, the main content sections, navigation menus, and any notable text or lists. Be terse — 3-5 sentences.",
        images: [shot.toString("base64")],
      }],
    }),
  });
  if (!res.ok) return "";
  const body = await res.json();
  return (body?.message?.content ?? "").slice(0, 1200);
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Could not parse JSON from model output");
  }
}

/** Compact list of interactive elements to ground the LLM plan. */
export async function summarizePage(page) {
  try {
    const items = await page.$$eval(
      "a[href], button, input, select, textarea, [role=button]",
      (els) =>
        els.slice(0, 60).map((el) => {
          const tag = el.tagName.toLowerCase();
          const text = (el.innerText || el.value || el.getAttribute("aria-label") || "")
            .trim()
            .slice(0, 80);
          const id = el.id ? `#${el.id}` : "";
          const name = el.getAttribute("name") ? `[name="${el.getAttribute("name")}"]` : "";
          const type = el.getAttribute("type") ? `[type="${el.getAttribute("type")}"]` : "";
          const role = el.getAttribute("role") ? ` role=${el.getAttribute("role")}` : "";
          const href = el.getAttribute("href") ? ` href="${el.href}"` : "";
          return `<${tag}${id}${name}${type}${role}${href}> ${text}`.trim();
        })
    );
    const title = await page.title().catch(() => "");
    const text = await page.evaluate(() =>
      (document.body?.innerText ?? "").replace(/\s{3,}/g, "\n").trim().slice(0, 2500)
    ).catch(() => "");
    return `url: ${page.url()}\ntitle: ${title}\n\nvisible text:\n${text}\n\ninteractive elements:\n${items.join("\n")}`;
  } catch {
    return `url: ${page.url()}`;
  }
}
