import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

export function htmlToMarkdown(html, url) {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const content = article?.content || html;
    const markdown = turndown.turndown(content);
    return { markdown, title: article?.title || dom.window.document.title || "" };
  } catch {
    return { markdown: turndown.turndown(html), title: "" };
  }
}
