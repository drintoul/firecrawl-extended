import { htmlToMarkdown } from "./markdown.js";

const DEFAULT_FORMATS = ["markdown"];
const MAX_ARTIFACT_B64 = 25 * 1024 * 1024; // 25 MB cap on inline artifacts

/**
 * Build the `data` object for a run, honoring Firecrawl-style `formats` plus
 * interact-specific ones: pdf, ariaSnapshot, console, errors, network,
 * cookies, storageState, tabs.
 */
export async function capture(session, formats = DEFAULT_FORMATS) {
  const page = session.page;
  const out = { url: page.url() };
  const wants = new Set(formats);

  const html = async () => (session._htmlCache ??= await page.content());
  const title = async () => (session._titleCache ??= await page.title().catch(() => ""));

  for (const fmt of wants) {
    switch (fmt) {
      case "markdown": {
        const { markdown, title: t } = htmlToMarkdown(await html(), page.url());
        out.markdown = markdown;
        if (t) out.metadata = { ...(out.metadata || {}), title: t };
        break;
      }
      case "html":
      case "rawHtml":
        out[fmt] = await html();
        break;
      case "links":
        out.links = await page.$$eval("a[href]", (as) =>
          as.map((a) => a.href).filter((h) => /^https?:/i.test(h))
        );
        break;
      case "screenshot":
      case "screenshot@fullPage":
        out.screenshot = (
          await page.screenshot({ fullPage: fmt.includes("fullPage"), type: "png" })
        ).toString("base64");
        break;
      case "pdf":
        if (page.context().browser()?.browserType().name() !== "chromium") {
          out.pdfError = "pdf format requires chromium";
        } else {
          out.pdf = (await page.pdf()).toString("base64");
        }
        break;
      case "ariaSnapshot":
        try {
          out.ariaSnapshot = await page.locator("body").ariaSnapshot();
        } catch {
          out.ariaSnapshot = await page.locator("html").ariaSnapshot();
        }
        break;
      case "console":
        out.console = session.console.slice();
        break;
      case "errors":
        out.errors = session.errors.slice();
        break;
      case "network":
        out.network = session.network.slice();
        break;
      case "cookies":
        out.cookies = await session.context.cookies();
        break;
      case "storageState":
        out.storageState = await session.context.storageState();
        break;
      case "tabs":
        out.tabs = session.pages.map((p, i) => ({
          index: i,
          url: p.url(),
          active: p === session.page,
          closed: p.isClosed(),
        }));
        break;
      default:
        break;
    }
  }

  if (wants.has("markdown") && !out.metadata?.title) {
    out.metadata = { ...(out.metadata || {}), title: await title() };
  }
  session._htmlCache = null;
  session._titleCache = null;
  return out;
}

/** Read an artifact file (trace.zip / har.har / video.webm) as base64. */
export async function artifactBase64(filePath) {
  const { readFile, stat } = await import("node:fs/promises");
  const s = await stat(filePath).catch(() => null);
  if (!s) return null;
  if (s.size > MAX_ARTIFACT_B64) {
    return { error: `artifact too large (${s.size} bytes)`, size: s.size };
  }
  return { base64: (await readFile(filePath)).toString("base64"), size: s.size };
}
