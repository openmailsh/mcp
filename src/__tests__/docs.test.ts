import { describe, expect, it } from "vitest";
import { chunkMarkdown, formatSearchResults, isAllowedDocsUrl, rankChunks } from "../docs";
import { formatDns, formatInboxes, formatThreads } from "../format";

describe("docs ranking", () => {
  it("returns cited chunks for a query", () => {
    const markdown = `# OpenMail\n\n## Send email\nUse POST /v1/inboxes/:id/send with body.\n\n## Custom domains\nAdd DNS records then verify.`;
    const chunks = chunkMarkdown(markdown, "https://openmail.sh/llms.txt");
    const ranked = rankChunks(chunks, "dns domain verify");
    expect(ranked[0]?.title).toMatch(/domain/i);
    expect(formatSearchResults(ranked)).toContain("Source:");
  });

  it("allowlists docs hosts", () => {
    expect(isAllowedDocsUrl("https://docs.openmail.sh/quickstart")).toBe(true);
    expect(isAllowedDocsUrl("https://evil.example/llms.txt")).toBe(false);
  });
});

describe("markdown formatters", () => {
  it("lists inboxes without dumping JSON", () => {
    const text = formatInboxes([
      { id: "i1", address: "bot@omail.sh", displayName: "Bot" },
    ]);
    expect(text).toContain("bot@omail.sh");
    expect(text).not.toContain("{");
  });

  it("renders pasteable DNS", () => {
    const text = formatDns({
      domain: "mail.acme.com",
      status: "pending",
      records: [
        {
          type: "TXT",
          name: "_dmarc.mail.acme.com",
          value: "v=DMARC1; p=none",
          purpose: "dmarc",
          status: "missing",
        },
      ],
    });
    expect(text).toContain("Paste these DNS records");
    expect(text).toContain("TXT _dmarc.mail.acme.com");
  });

  it("empty unread state", () => {
    expect(formatThreads([])).toContain("No unread");
  });
});
