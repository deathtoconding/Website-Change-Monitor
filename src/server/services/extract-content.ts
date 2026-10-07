import { load } from "cheerio";
import { normalizeContent } from "../../lib/monitoring.js";

export class ContentExtractionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ContentExtractionError";
    this.code = code;
  }
}

const MAX_SELECTOR_LENGTH = 160;
const MAX_EXTRACTED_TEXT_LENGTH = 2_000_000;

export function validateSelector(selector: string): string | null {
  const trimmed = selector.trim();
  if (trimmed.length > MAX_SELECTOR_LENGTH)
    return "CSS selectors must be 160 characters or fewer.";
  if (!trimmed) return null;
  try {
    const $ = load(
      "<!doctype html><html><body><main><p>validation fixture</p></main></body></html>",
    );
    $(trimmed);
    return null;
  } catch {
    return "The CSS selector is invalid.";
  }
}

/** Parse HTML without executing it and return stable, line-oriented visible text. */
export function extractText(html: string, selector = ""): string {
  let $: ReturnType<typeof load>;
  try {
    $ = load(html);
  } catch {
    throw new ContentExtractionError(
      "INVALID_HTML",
      "The response could not be parsed as HTML.",
    );
  }

  $(
    "head, script, style, noscript, svg, canvas, template, iframe, object, embed",
  ).remove();
  $('[hidden], [aria-hidden="true"]').remove();
  $("input, button, select, textarea").remove();

  const trimmedSelector = selector.trim();
  if (trimmedSelector.length > MAX_SELECTOR_LENGTH) {
    throw new ContentExtractionError(
      "SELECTOR_TOO_LONG",
      "CSS selectors must be 160 characters or fewer.",
    );
  }

  let roots;
  if (trimmedSelector) {
    try {
      roots = $(trimmedSelector);
    } catch {
      throw new ContentExtractionError(
        "INVALID_SELECTOR",
        "The CSS selector is invalid.",
      );
    }
    if (roots.length === 0) {
      throw new ContentExtractionError(
        "SELECTOR_NOT_FOUND",
        "The configured CSS selector did not match any page content.",
      );
    }
  } else {
    const main = $("main");
    roots = main.length > 0 ? main : $("body");
    if (main.length === 0) roots.find("nav, footer, aside").remove();
  }

  // Cheerio's text() concatenates adjacent elements. Use a sentinel for block
  // boundaries, then collapse author whitespace (including source line wraps)
  // without erasing the structural breaks we deliberately add.
  const blockSeparator = "\uE000";
  roots.find("br").replaceWith(blockSeparator);
  roots
    .find(
      "h1, h2, h3, h4, h5, h6, p, li, dt, dd, td, th, tr, section, article, div, blockquote, pre, hr",
    )
    .each((_, element) => {
      $(element).append(blockSeparator);
    });
  const rawText = roots
    .text()
    .replace(/[\s\u00a0]+/gu, " ")
    .split(blockSeparator)
    .join("\n");

  if (rawText.length > MAX_EXTRACTED_TEXT_LENGTH) {
    throw new ContentExtractionError(
      "CONTENT_TOO_LARGE",
      "The extracted page content exceeds the supported limit.",
    );
  }
  const normalized = normalizeContent(rawText);
  if (!normalized)
    throw new ContentExtractionError(
      "EMPTY_CONTENT",
      "No readable page text was found.",
    );
  return normalized;
}
