import type { LlmsTxtSection } from "./types.js";

export function buildLlmsTxt(sections: LlmsTxtSection[]): string {
  const parts: string[] = [];

  for (const section of sections) {
    parts.push(`# ${section.heading}`);
    parts.push("");

    for (const item of section.items) {
      const description = item.description !== undefined ? `: ${item.description}` : "";
      parts.push(`- [${item.title}](${item.url})${description}`);
    }

    parts.push("");
  }

  return parts.join("\n");
}
