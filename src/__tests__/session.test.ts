import { describe, expect, it } from "vitest";
import { parseSessionFromUrl, visibleTools, assertLockedInbox, type SessionContext } from "../session";

function base(over: Partial<SessionContext> = {}): SessionContext {
  return {
    readonly: false,
    inboxId: null,
    toolsets: new Set(["docs", "mailbox", "domains"]),
    token: "om_x",
    scopes: null,
    apiKeyInboxId: null,
    apiKeyPodId: null,
    authKind: "api_key",
    ...over,
  };
}

describe("parseSessionFromUrl", () => {
  it("reads readonly, inbox lock, and toolsets", () => {
    expect(parseSessionFromUrl("/mcp/readonly", {}).readonly).toBe(true);
    expect(parseSessionFromUrl("/mcp?readonly=true", {}).readonly).toBe(true);
    expect(parseSessionFromUrl("/mcp/inbox/abc", {}).inboxId).toBe("abc");
    expect([...parseSessionFromUrl("/mcp?toolsets=docs", {}).toolsets]).toEqual([
      "docs",
    ]);
  });
});

describe("visibleTools", () => {
  it("exposes only docs when unauthenticated", () => {
    expect(
      visibleTools(base({ authKind: "none", token: null })),
    ).toEqual(["search_docs", "get_docs"]);
  });

  it("hides list_inboxes when inbox-locked", () => {
    const tools = visibleTools(base({ inboxId: "inbox-1" }));
    expect(tools).not.toContain("list_inboxes");
    expect(tools).toContain("read_thread");
  });

  it("hides send on readonly and when OAuth omitted send", () => {
    expect(visibleTools(base({ readonly: true }))).not.toContain("send_email");
    expect(
      visibleTools(
        base({
          authKind: "oauth",
          scopes: ["read", "setup"],
        }),
      ),
    ).not.toContain("send_email");
    expect(
      visibleTools(
        base({
          authKind: "oauth",
          scopes: ["read", "send"],
        }),
      ),
    ).toContain("send_email");
  });

  it("hides every write tool on readonly, including mark_thread_read", () => {
    const tools = visibleTools(base({ readonly: true }));
    for (const write of [
      "mark_thread_read",
      "send_email",
      "reply_to_thread",
      "create_inbox",
      "mint_inbox_key",
      "add_domain",
      "verify_domain",
    ]) {
      expect(tools).not.toContain(write);
    }
    expect(tools).toContain("read_thread");
    expect(tools).toContain("list_unread_threads");
    // Non-readonly sessions keep it.
    expect(visibleTools(base())).toContain("mark_thread_read");
  });

  it("hides account tools for an inbox-scoped API key", () => {
    const tools = visibleTools(base({ apiKeyInboxId: "inbox-1" }));
    expect(tools).not.toContain("list_inboxes");
    expect(tools).not.toContain("create_inbox");
    expect(tools).not.toContain("add_domain");
    expect(tools).not.toContain("setup_agent_email");
    expect(tools).toContain("reply_to_thread");
  });

  it("shows setup_agent_email only where it can actually run", () => {
    // Account-wide API key: scopes null → allowed.
    expect(visibleTools(base())).toContain("setup_agent_email");
    // Readonly, URL-locked, or OAuth without `setup`: it would only fail.
    expect(visibleTools(base({ readonly: true }))).not.toContain("setup_agent_email");
    expect(visibleTools(base({ inboxId: "inbox-1" }))).not.toContain("setup_agent_email");
    expect(
      visibleTools(base({ authKind: "oauth", scopes: ["read", "send"] })),
    ).not.toContain("setup_agent_email");
    expect(
      visibleTools(base({ authKind: "oauth", scopes: ["read", "setup"] })),
    ).toContain("setup_agent_email");
  });

  it("read-only OAuth exposes exactly the read tools plus mark_thread_read", () => {
    const tools = visibleTools(base({ authKind: "oauth", scopes: ["read"] }));
    expect([...tools].sort()).toEqual(
      [
        "search_docs",
        "get_docs",
        "auth_me",
        "send_mcp_feedback",
        "list_inboxes",
        "get_inbox",
        "list_unread_threads",
        "read_thread",
        "get_attachment_text",
        "mark_thread_read",
        "list_domains",
        "get_domain",
      ].sort(),
    );
    expect(tools).toHaveLength(12);
  });
});

describe("assertLockedInbox", () => {
  it("no-ops when the session is not inbox-locked", () => {
    expect(() => assertLockedInbox(base(), "inbox-other")).not.toThrow();
  });

  it("rejects a thread from another inbox", () => {
    expect(() =>
      assertLockedInbox(base({ inboxId: "inbox-1" }), "inbox-2"),
    ).toThrow(/cannot access that inbox/);
    expect(() =>
      assertLockedInbox(base({ apiKeyInboxId: "inbox-1" }), "inbox-2"),
    ).toThrow(/cannot access that inbox/);
  });

  it("allows the locked inbox", () => {
    expect(() =>
      assertLockedInbox(base({ inboxId: "inbox-1" }), "inbox-1"),
    ).not.toThrow();
  });
});
