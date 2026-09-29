// Locator resolution following Playwright best practices:
// https://playwright.dev/docs/locators — prefer user-facing getBy* locators,
// then text/role engines, then CSS/XPath.

/**
 * Resolve an action `target` into a Playwright Locator.
 *
 * Accepted forms:
 *   "css selector"                        — CSS (default engine)
 *   "text=Foo" | "xpath=//..." | "role=button[name='X']" | "id=..." | "data-testid=..."
 *   { "selector": "css", ... }            — explicit CSS/engine string
 *   { "getBy": "role", "role": "button", "name": "Submit", "exact": true }
 *   { "getBy": "text"|"label"|"placeholder"|"altText"|"title"|"testId", "value": "..." }
 *
 * Modifiers on any object form:
 *   nth, first, last                      — index into the match set
 *   hasText/hasNotText, has/hasNot, visible — locator.filter()
 *   frame                                 — "css of iframe" | {name} | {url} | {index}
 */
export function resolveLocator(page, target) {
  if (target == null) throw new Error("action requires a `selector` or `target`");
  const t = typeof target === "string" ? { selector: target } : { ...target };
  // `selector` shorthand folded into target
  const scope = resolveScope(page, t.frame);
  return locateInScope(scope, t);
}

/** Resolve a frame reference to a real Frame (or Page) — for evaluate etc. */
export async function resolveFrame(page, frameRef) {
  if (!frameRef) return page;
  if (typeof frameRef === "string") {
    const f = await page.locator(frameRef).first().contentFrame();
    if (!f) throw new Error(`no contentFrame for "${frameRef}"`);
    return f;
  }
  const scope = resolveScope(page, frameRef);
  if (scope.locator) {
    // FrameLocator — get the underlying frame via the iframe element
    throw new Error("frame reference must resolve to a Frame (use {name|url|index} or iframe CSS)");
  }
  return scope; // Page | Frame
}

/** Resolve optional frame reference -> Page | Frame | FrameLocator */
export function resolveScope(page, frameRef) {
  if (!frameRef) return page;
  if (typeof frameRef === "string") return page.frameLocator(frameRef);
  if (frameRef.name !== undefined) {
    const f = page.frames().find((x) => x.name() === frameRef.name);
    if (!f) throw new Error(`frame named "${frameRef.name}" not found`);
    return f;
  }
  if (frameRef.url !== undefined) {
    const re = toRegExp(frameRef.url);
    const f = page
      .frames()
      .find((x) => (re ? re.test(x.url()) : x.url().includes(String(frameRef.url))));
    if (!f) throw new Error(`frame with url matching "${frameRef.url}" not found`);
    return f;
  }
  if (frameRef.index !== undefined) {
    const f = page.frames()[frameRef.index];
    if (!f) throw new Error(`frame index ${frameRef.index} not found`);
    return f;
  }
  throw new Error("invalid `frame` reference (use a CSS string or {name|url|index})");
}

function locateInScope(scope, t) {
  let loc;
  if (t.getBy) loc = getByLocator(scope, t);
  else if (t.selector) loc = scope.locator(t.selector);
  else if (t.role) loc = scope.getByRole(t.role, roleOptions(t));
  else if (t.text !== undefined) loc = scope.getByText(t.text, { exact: t.exact });
  else if (t.label !== undefined) loc = scope.getByLabel(t.label, { exact: t.exact });
  else if (t.testId !== undefined) loc = scope.getByTestId(t.testId);
  else throw new Error("target needs `selector`, `getBy`, `role`, `text`, `label` or `testId`");

  const filter = {};
  if (t.hasText !== undefined) filter.hasText = t.hasText;
  if (t.hasNotText !== undefined) filter.hasNotText = t.hasNotText;
  if (t.has !== undefined) filter.has = locateInScope(scope, norm(t.has));
  if (t.hasNot !== undefined) filter.hasNot = locateInScope(scope, norm(t.hasNot));
  if (t.visible !== undefined) filter.visible = t.visible;
  if (Object.keys(filter).length) loc = loc.filter(filter);

  if (t.nth !== undefined) loc = loc.nth(t.nth);
  else if (t.first) loc = loc.first();
  else if (t.last) loc = loc.last();
  return loc;
}

function norm(x) {
  return typeof x === "string" ? { selector: x } : x;
}

function getByLocator(scope, t) {
  switch (t.getBy) {
    case "role":
      return scope.getByRole(t.role, roleOptions(t));
    case "text":
      return scope.getByText(t.value ?? t.text, { exact: t.exact });
    case "label":
      return scope.getByLabel(t.value ?? t.label, { exact: t.exact });
    case "placeholder":
      return scope.getByPlaceholder(t.value ?? t.placeholder, { exact: t.exact });
    case "altText":
      return scope.getByAltText(t.value ?? t.altText, { exact: t.exact });
    case "title":
      return scope.getByTitle(t.value ?? t.title, { exact: t.exact });
    case "testId":
      return scope.getByTestId(t.value ?? t.testId);
    default:
      throw new Error(`unknown getBy strategy "${t.getBy}"`);
  }
}

function roleOptions(t) {
  const o = {};
  for (const k of [
    "name",
    "exact",
    "checked",
    "disabled",
    "expanded",
    "includeHidden",
    "level",
    "pressed",
    "selected",
  ]) {
    if (t[k] !== undefined) o[k] = t[k];
  }
  return o;
}

/** Convert a glob string ("*iana.org*") to a RegExp. */
export function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "￿")          // ** placeholder
    .replace(/\*/g, "[^/]*")
    .replace(/￿/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i");
}

/** Accept "/re/flags", or return null for plain strings/globs. */
export function toRegExp(v) {
  if (v instanceof RegExp) return v;
  if (typeof v !== "string") return null;
  const m = v.match(/^\/(.*)\/([a-z]*)$/i);
  if (m) {
    try { return new RegExp(m[1], m[2]); } catch { return null; }
  }
  return null;
}

/**
 * URL matcher usable by Playwright (waitForURL / route / waitForResponse).
 * Follows playwright.dev semantics: "/re/" -> RegExp, "*..*" -> glob,
 * anything else -> exact/partial match predicate.
 */
export function urlMatcher(v) {
  if (v instanceof RegExp) return v;
  if (typeof v !== "string") return v;
  const re = toRegExp(v);
  if (re) return re;
  if (v.includes("*") || v.includes("?")) return globToRegExp(v);
  return (url) => String(url).includes(v);
}

/** Match a url against a matcher produced by urlMatcher/toRegExp. */
export function matchUrl(matcher, url) {
  if (matcher instanceof RegExp) return matcher.test(url);
  if (typeof matcher === "function") return matcher(url);
  if (typeof matcher === "string") return url.includes(matcher);
  return false;
}
