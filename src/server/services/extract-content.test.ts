import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diffText } from "../../lib/monitoring.js";
import { ContentExtractionError, extractText } from "./extract-content.js";

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../../fixtures/${name}`, import.meta.url),
    "utf8",
  );
}

describe("extractText", () => {
  it("removes scripts, styles, SVG and hidden text without executing HTML", () => {
    const html = `<!doctype html><html><head><title>Ignore title</title><style>.noise {}</style></head><body>
      <main><h1>Pro plan</h1><p>$49 per month</p><script>window.stolen = true</script>
      <svg><text>icon label</text></svg><div hidden>hidden offer</div><div aria-hidden="true">screen reader noise</div></main>
    </body></html>`;
    expect(extractText(html)).toBe("Pro plan\n$49 per month");
  });

  it("extracts only content matching the selected page element", () => {
    const html =
      "<html><body><nav>Navigation</nav><main><h1>Pricing</h1><p>Starter plan</p></main></body></html>";
    expect(extractText(html, "main")).toBe("Pricing\nStarter plan");
  });

  it("reports missing or oversized selectors as explicit errors", () => {
    expect(() =>
      extractText(
        "<html><body><main>Pricing</main></body></html>",
        ".not-found",
      ),
    ).toThrowError(ContentExtractionError);
    expect(() => extractText("<p>Content</p>", "x".repeat(161))).toThrowError(
      ContentExtractionError,
    );
  });

  it("tolerates malformed markup and normalizes whitespace", () => {
    expect(
      extractText("<main><h1>Pro</h1><p>$49\r\n   monthly <b>billing</main>"),
    ).toBe("Pro\n$49 monthly billing");
  });

  it("uses deterministic local fixtures to verify change, addition, and removal extraction", () => {
    const initial = extractText(fixture("initial.html"));
    const priceChanged = extractText(fixture("changed-price.html"));
    const featureAdded = extractText(fixture("added-content.html"));
    const featureRemoved = extractText(fixture("removed-content.html"));

    expect(diffText(initial, priceChanged)).toContainEqual({
      kind: "removed",
      text: "$49 per month",
    });
    expect(diffText(initial, priceChanged)).toContainEqual({
      kind: "added",
      text: "$59 per month",
    });
    expect(diffText(initial, featureAdded)).toContainEqual({
      kind: "added",
      text: "Priority support",
    });
    expect(diffText(initial, featureRemoved)).toContainEqual({
      kind: "removed",
      text: "Unlimited projects",
    });
  });

  it("ignores known page chrome and executable/dynamic markup noise", () => {
    expect(extractText(fixture("dynamic-noise.html"))).toBe(
      extractText(fixture("unchanged.html")),
    );
  });

  it("parses malformed and large local fixtures without losing content", () => {
    expect(extractText(fixture("malformed.html"))).toBe(
      "Pro\n$49 monthly billing",
    );
    expect(extractText(fixture("large-page.html")).split("\n")).toHaveLength(
      512,
    );
  });

  it("fails visibly rather than saving an empty baseline", () => {
    expect(() =>
      extractText("<script>empty</script><style>.x {}</style>"),
    ).toThrowError("No readable page text was found.");
  });
});
