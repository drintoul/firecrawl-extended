import { ACTION_TYPES } from "./actions.js";

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://ollama:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";

const SYSTEM_PROMPT = `You convert a natural-language instruction into a JSON plan of browser actions for Playwright.

Reply with ONLY a JSON object: {"actions": [...]} — no prose, no markdown fences.

Every action has a "type". Useful types:

Navigation/wait:
- {"type":"goto","url":"https://..."}
- {"type":"wait","milliseconds":1000}
- {"type":"waitForSelector","target":<target>,"state":"visible"}
- {"type":"waitForURL","url":"*/dashboard*"}
- {"type":"waitForLoadState","state":"networkidle"}

Input — any "target" may be:
  "css selector" | "text=Foo" | "role=button[name='Save']"
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
- Keep plans under 15 actions. Do not invent credentials or personal data.
- End the plan with {"type":"scrape"} so the final page state is captured.`;

/**
 * Ask Ollama to convert `prompt` (plus a compact description of the current
 * page) into an action list. Returns an array of validated actions.
 */
export async function planActions(prompt, pageSummary) {
  const user = [
    `Instruction: ${prompt}`,
    pageSummary ? `\nCurrent page snapshot:\n${pageSummary}` : "",
  ].join("\n");

  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
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

  return actions
    .filter((a) => a && typeof a === "object" && ACTION_TYPES.includes(a.type))
    .slice(0, 25);
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
          return `<${tag}${id}${name}${type}${role}> ${text}`.trim();
        })
    );
    const title = await page.title().catch(() => "");
    return `url: ${page.url()}\ntitle: ${title}\ninteractive elements:\n${items.join("\n")}`;
  } catch {
    return `url: ${page.url()}`;
  }
}
