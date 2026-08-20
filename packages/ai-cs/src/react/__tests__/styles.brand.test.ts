import { describe, expect, it } from "vitest";
import { AI_CS_STYLES, resolveAiCsBrand } from "../styles.js";

// Canonical active brand presets. These accents are the single source of
// truth shared with the deployed ai-sdr hosted-client and the importable
// @ventora/ai-sdr widget. This suite locks the ai-cs side of that contract so
// no product can silently drift off its accent or clone another product's
// palette.
const CANONICAL_BRANDS = [
  { id: "camaudit", accentColor: "#1f5a52", surfaceColor: "#fbfefd", textColor: "#071426" },
  { id: "capveri", accentColor: "#4f46e5", surfaceColor: "#fbfbff", textColor: "#141528" },
  { id: "grantpipe", accentColor: "#15803d", surfaceColor: "#fbfdf8", textColor: "#102015" },
  { id: "lextract", accentColor: "#b45309", surfaceColor: "#fffdfa", textColor: "#1d1712" },
] as const;

describe("resolveAiCsBrand canonical presets", () => {
  it.each(CANONICAL_BRANDS)("resolves the $id preset to its canonical palette", (expected) => {
    const resolved = resolveAiCsBrand({ id: expected.id });
    expect(resolved.id).toBe(expected.id);
    expect(resolved.accentColor).toBe(expected.accentColor);
    expect(resolved.accentTextColor).toBe("#ffffff");
    expect(resolved.surfaceColor).toBe(expected.surfaceColor);
    expect(resolved.textColor).toBe(expected.textColor);
  });

  it("gives every shipped product a distinct accent so no two widgets look alike", () => {
    const accents = CANONICAL_BRANDS.map((brand) =>
      resolveAiCsBrand({ id: brand.id }).accentColor.toLowerCase(),
    );
    const unique = new Set(accents);
    expect(unique.size).toBe(CANONICAL_BRANDS.length);
  });

  it("falls back to ventora default tokens for an unknown product id", () => {
    const resolved = resolveAiCsBrand({ id: "totally-unknown-product" });
    expect(resolved.accentColor).toBe("#0f172a");
    expect(resolved.accentTextColor).toBe("#ffffff");
    expect(resolved.surfaceColor).toBe("#f8fafc");
    expect(resolved.textColor).toBe("#0f172a");
  });

  it("falls back to the ventora id when no brand is supplied", () => {
    expect(resolveAiCsBrand(undefined).id).toBe("ventora");
    expect(resolveAiCsBrand({}).id).toBe("ventora");
  });

  it("lets an explicit override win over the preset accent", () => {
    const resolved = resolveAiCsBrand({ id: "camaudit", accentColor: "#abcdef" });
    expect(resolved.accentColor).toBe("#abcdef");
    // Non-overridden tokens still come from the camaudit preset.
    expect(resolved.surfaceColor).toBe("#fbfefd");
  });
});

describe("AI_CS_STYLES composer field background", () => {
  it("derives composer textarea background from surface+text tokens (not a hardcoded white)", () => {
    expect(AI_CS_STYLES).toContain(
      "background:color-mix(in srgb,var(--aics-text,#0f172a) 4%,var(--aics-surface,#fff))",
    );
  });

  it("does not contain a hardcoded background:#fff on the composer textarea rule", () => {
    // Confirm the old hardcoded white is gone from the textarea rule.
    // We check the textarea rule specifically by verifying the token-derived value
    // is present while the literal hardcoded value is absent from that segment.
    const textareaRuleStart = AI_CS_STYLES.indexOf("[data-aics-composer] textarea{");
    expect(textareaRuleStart).toBeGreaterThan(-1);
    const textareaRuleEnd = AI_CS_STYLES.indexOf("}", textareaRuleStart);
    const textareaRule = AI_CS_STYLES.slice(textareaRuleStart, textareaRuleEnd + 1);
    expect(textareaRule).not.toContain("background:#fff;");
  });
});

describe("AI_CS_STYLES table styles", () => {
  it("includes the [data-aics-table] rule scoped to assistant bubbles", () => {
    expect(AI_CS_STYLES).toContain("[data-aics-table]");
  });

  it("includes the [data-aics-table-wrap] overflow scroll rule", () => {
    expect(AI_CS_STYLES).toContain("[data-aics-table-wrap]");
    expect(AI_CS_STYLES).toContain("overflow-x:auto");
  });

  it("uses color-mix for table cell borders (no hardcoded hex borders)", () => {
    const tableRuleStart = AI_CS_STYLES.indexOf(
      '[data-aics-bubble][data-aics-role="assistant"] [data-aics-table] th,',
    );
    expect(tableRuleStart).toBeGreaterThan(-1);
    const tableRuleEnd = AI_CS_STYLES.indexOf("}", tableRuleStart);
    const tableRule = AI_CS_STYLES.slice(tableRuleStart, tableRuleEnd + 1);
    expect(tableRule).toContain("color-mix(in srgb,var(--aics-text");
  });

  it("gives th a font-weight 600 and token-derived background", () => {
    expect(AI_CS_STYLES).toContain("font-weight:600");
    expect(AI_CS_STYLES).toContain(
      "background:color-mix(in srgb,var(--aics-text,#0f172a) 5%,var(--aics-surface,#fff))",
    );
  });
});

describe("AI_CS_STYLES auto-dark chip contrast", () => {
  it("includes the auto-dark chip selector group targeting suggestion, source, and source-plain", () => {
    expect(AI_CS_STYLES).toContain(
      "[data-aics-root]:not([data-aics-theme]) [data-aics-suggestion]",
    );
    expect(AI_CS_STYLES).toContain("[data-aics-root]:not([data-aics-theme]) [data-aics-source]");
    expect(AI_CS_STYLES).toContain(
      "[data-aics-root]:not([data-aics-theme]) [data-aics-source-plain]",
    );
  });

  it("sets chip color to --aics-text in the auto-dark block", () => {
    expect(AI_CS_STYLES).toContain(
      "[data-aics-root]:not([data-aics-theme]) [data-aics-source-plain]{color:var(--aics-text)",
    );
  });

  it("sets chip border-color to a 30% color-mix of --aics-text in the auto-dark block", () => {
    expect(AI_CS_STYLES).toContain(
      "border-color:color-mix(in srgb,var(--aics-text) 30%,transparent)",
    );
  });
});
