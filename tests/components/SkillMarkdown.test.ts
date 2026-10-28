import { describe, expect, it } from "vitest";
import {
  splitSkillMarkdown,
  unwrapQuotePrefix,
} from "@/components/skills/SkillMarkdown";

describe("splitSkillMarkdown", () => {
  it("always separates YAML frontmatter from the markdown body", () => {
    const raw = `---
name: humanizer
description: Rewrite AI-sounding text
---

# Humanizer

Use when asked to rewrite text.
`;
    const parsed = splitSkillMarkdown(raw);
    expect(parsed.hasYaml).toBe(true);
    expect(parsed.yaml).toContain("name: humanizer");
    expect(parsed.body).toContain("# Humanizer");
    expect(parsed.body.startsWith("---")).toBe(false);
  });

  it("treats files without a frontier as body-only", () => {
    const parsed = splitSkillMarkdown("# Just a heading\n\nHello.");
    expect(parsed.hasYaml).toBe(false);
    expect(parsed.yaml).toBe("");
    expect(parsed.body).toContain("# Just a heading");
  });
});

describe("unwrapQuotePrefix", () => {
  it("treats >, > text, and >heading as quote lines", () => {
    expect(unwrapQuotePrefix(">")).toBe("");
    expect(unwrapQuotePrefix("> ")).toBe("");
    expect(unwrapQuotePrefix("> Speed matters.")).toBe("Speed matters.");
    expect(unwrapQuotePrefix(">## Performance")).toBe("## Performance");
    expect(unwrapQuotePrefix("plain")).toBeNull();
  });
});
