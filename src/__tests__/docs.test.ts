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

describe("rankChunks", () => {
  const url = "https://openmail.sh/llms.txt";
  // Mimics the shape of the real llms.txt: a couple of short API sections and
  // one long integrations page that name-drops everything once.
  const integrations = [
    "Connect OpenMail to OpenClaw, Hermes, and other agent frameworks.",
    "Each integration can list inboxes, read a thread, reply, send email, add a domain, verify a domain, and mint keys.",
    "OpenClaw: install the plugin, paste your API key, and pick an inbox. Hermes: add the MCP URL to your config.",
    "Both frameworks poll for unread mail and surface it to the agent as a thread with the sender address.",
    "See the framework docs for authentication, rate limits, retries, webhooks, and deployment guidance.",
  ].join(" ").repeat(4);
  const corpus = [
    { title: "Integrations", url, text: `## Integrations\n${integrations}` },
    { title: "Send email", url, text: "## Send email\nPOST /v1/inboxes/:id/send starts a new thread from an inbox." },
    { title: "Reply to a thread", url, text: "## Reply to a thread\nPOST /v1/inboxes/:id/send with threadId keeps the reply in the same thread." },
    { title: "Threads and replies", url, text: "## Threads and replies\nA thread groups inbound and outbound messages; reply with threadId." },
    { title: "Custom domains", url, text: "## Custom domains\nAdd DNS records then verify the domain." },
  ];

  it("ranks the reply section above an integrations page that mentions reply once per paragraph", () => {
    const ranked = rankChunks(corpus, "reply to a thread");
    expect(ranked[0]?.title).toBe("Reply to a thread");
    expect(ranked.map((c) => c.title).indexOf("Integrations")).toBeGreaterThan(
      ranked.map((c) => c.title).indexOf("Threads and replies"),
    );
  });

  it("ignores stop words and still matches on the meaningful terms", () => {
    const ranked = rankChunks(corpus, "how do i reply");
    expect(ranked[0]?.title).toMatch(/reply|replies/i);
    expect(rankChunks(corpus, "the a to")).toEqual([]);
  });

  it("prefers title matches over body-only matches", () => {
    const ranked = rankChunks(corpus, "domains");
    expect(ranked[0]?.title).toBe("Custom domains");
  });

  it("caps term frequency so repetition alone cannot win", () => {
    const spam = { title: "Misc", url, text: `## Misc\n${"thread ".repeat(200)}` };
    const ranked = rankChunks([...corpus, spam], "reply to a thread");
    expect(ranked[0]?.title).toBe("Reply to a thread");
  });

  it("drops chunks with no matching term", () => {
    expect(rankChunks(corpus, "kubernetes")).toEqual([]);
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
