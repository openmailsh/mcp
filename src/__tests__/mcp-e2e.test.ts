/**
 * Drives the hosted MCP server the way Claude / Cursor do: a real
 * `@modelcontextprotocol/sdk` client over Streamable HTTP against `createApp()`
 * listening on an ephemeral port. The only thing faked is the OpenMail API
 * (`helpers/fake-openmail-api.ts`), which is the server's one outbound network
 * dependency. Auth, session parsing, tool filtering, inbox locking, and the
 * tool handlers themselves all run for real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ALL_TOOLS } from "../session.js";
import {
  startFakeOpenMailApi,
  type FakeOpenMailApi,
  type FakeState,
} from "./helpers/fake-openmail-api.js";

const MCP_SECRET = "test-mcp-secret-at-least-32-chars-long!!";
const MCP_RESOURCE = "https://mcp.openmail.sh";

const ACCOUNT_KEY = "om_account_key";
const INBOX_A_KEY = "om_inbox_a_key";

let api: FakeOpenMailApi;
let mcpServer: http.Server;
let mcpBase: string;

/** Two inboxes, threads in each, one attachment — enough to prove isolation. */
function seed(): FakeState {
  return {
    tokens: {
      [ACCOUNT_KEY]: { customerId: "cust-1", plan: "developer", apiKeyScope: "account", mcpScopes: null },
      [INBOX_A_KEY]: {
        customerId: "cust-1",
        plan: "developer",
        apiKeyScope: { podId: "pod-1", inboxId: "inbox-a" },
        mcpScopes: null,
      },
    },
    inboxes: [
      { id: "inbox-a", address: "a@omail.sh", displayName: "A" },
      { id: "inbox-b", address: "b@omail.sh", displayName: "B" },
    ],
    threads: {
      "thread-a1": {
        id: "thread-a1",
        inboxId: "inbox-a",
        subject: "Invoice question",
        isRead: false,
        lastMessageAt: "2026-09-10T10:00:00Z",
        messages: [
          { id: "msg-a1", direction: "inbound", fromAddr: "human@example.com", bodyText: "Where is my invoice?", autoReplyable: true, attachments: [{ filename: "invoice.pdf" }] },
        ],
      },
      "thread-a2": {
        id: "thread-a2",
        inboxId: "inbox-a",
        subject: "Weekly newsletter",
        isRead: false,
        lastMessageAt: "2026-09-10T09:00:00Z",
        messages: [
          { id: "msg-a2", direction: "inbound", fromAddr: "news@marketing.example", bodyText: "Deals!", autoReplyable: false },
        ],
      },
      "thread-b1": {
        id: "thread-b1",
        inboxId: "inbox-b",
        subject: "Other inbox thread",
        isRead: false,
        lastMessageAt: "2026-09-10T08:00:00Z",
        messages: [
          { id: "msg-b1", direction: "inbound", fromAddr: "someone@example.com", bodyText: "Hello B", autoReplyable: true },
        ],
      },
    },
    attachments: {
      "msg-a1/invoice.pdf": { inboxId: "inbox-a", text: "Invoice #42 total 100 EUR" },
      "msg-b1/other.pdf": { inboxId: "inbox-b", text: "Secret from inbox B" },
    },
  };
}

beforeAll(async () => {
  api = await startFakeOpenMailApi(seed());
  // `index.ts` reads OPENMAIL_API_URL at import time, so env goes first and the
  // app is imported dynamically. The same URL doubles as the JWT issuer.
  process.env.OPENMAIL_API_URL = api.url;
  process.env.MCP_JWT_SECRET = MCP_SECRET;
  process.env.MCP_RESOURCE_URL = MCP_RESOURCE;
  const { createApp } = await import("../index.js");
  const app = createApp();
  mcpServer = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  mcpBase = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
  await api.close();
});

beforeEach(() => {
  api.reset(seed());
});

const openClients: Client[] = [];
afterEach(async () => {
  await Promise.all(openClients.splice(0).map((c) => c.close().catch(() => {})));
});

async function connect(path: string, token?: string, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const transport = new StreamableHTTPClientTransport(new URL(mcpBase + path), {
    requestInit: { headers },
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  openClients.push(client);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return { isError: Boolean(result.isError), text: content.map((c) => c.text ?? "").join("\n") };
}

async function mcpJwt(scope: string, overrides: { aud?: string; secret?: string } = {}) {
  return new SignJWT({ token_use: "mcp_at", grant_id: "grant-1", customer_id: "cust-1", scope })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(api.url)
    .setAudience(overrides.aud ?? MCP_RESOURCE)
    .setSubject("cust-1")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(overrides.secret ?? MCP_SECRET));
}

/** A JWT the API still recognises (the grant behind it has not been revoked). */
async function oauthToken(scope: string) {
  const token = await mcpJwt(scope);
  api.state.tokens[token] = {
    customerId: "cust-1",
    plan: "developer",
    apiKeyScope: "account",
    mcpScopes: scope.split(" "),
  };
  return token;
}

const sorted = (names: readonly string[]) => [...names].sort();
const without = (names: readonly string[], ...drop: string[]) => sorted(names.filter((n) => !drop.includes(n)));

const WRITE_TOOLS = ["setup_agent_email", "send_email", "reply_to_thread", "mark_thread_read", "create_inbox", "mint_inbox_key", "add_domain", "verify_domain"];

// ---------------------------------------------------------------------------
// Tool surface per endpoint / credential
// ---------------------------------------------------------------------------

describe("tools/list", () => {
  it("a missing credential at /mcp is a 401 with WWW-Authenticate so clients start OAuth", async () => {
    const res = await fetch(`${mcpBase}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    await expect(connect("/mcp")).rejects.toMatchObject({ code: 401 });
    expect(api.requests).toHaveLength(0);
  });

  it("unauthenticated sessions at /mcp/public see only the docs tools", async () => {
    const client = await connect("/mcp/public");
    expect(await toolNames(client)).toEqual(["get_docs", "search_docs"]);
    expect(api.requests).toHaveLength(0);
  });

  it("an account-wide om_ key at /mcp sees every tool", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    expect(await toolNames(client)).toEqual(sorted(ALL_TOOLS));
  });

  it("/mcp/readonly and /mcp?readonly=true hide every write tool and agree with each other", async () => {
    const viaPath = await toolNames(await connect("/mcp/readonly", ACCOUNT_KEY));
    const viaQuery = await toolNames(await connect("/mcp?readonly=true", ACCOUNT_KEY));
    expect(viaPath).toEqual(without(ALL_TOOLS, ...WRITE_TOOLS));
    expect(viaQuery).toEqual(viaPath);
  });

  it("/mcp/inbox/{id} drops list_inboxes, setup_agent_email, and create_inbox", async () => {
    const client = await connect("/mcp/inbox/inbox-a", ACCOUNT_KEY);
    expect(await toolNames(client)).toEqual(
      without(ALL_TOOLS, "list_inboxes", "setup_agent_email", "create_inbox"),
    );
  });

  it("?toolsets=docs and the X-MCP-Toolsets header select the same subset", async () => {
    const viaQuery = await toolNames(await connect("/mcp?toolsets=docs", ACCOUNT_KEY));
    const viaHeader = await toolNames(await connect("/mcp", ACCOUNT_KEY, { "X-MCP-Toolsets": "docs" }));
    expect(viaQuery).toEqual(
      sorted(["search_docs", "get_docs", "auth_me", "send_mcp_feedback", "setup_agent_email", "create_inbox", "mint_inbox_key"]),
    );
    expect(viaHeader).toEqual(viaQuery);
  });

  it("an inbox-scoped om_ key cannot see setup, listing, or domain tools", async () => {
    const client = await connect("/mcp", INBOX_A_KEY);
    expect(await toolNames(client)).toEqual(
      sorted([
        "search_docs", "get_docs", "auth_me", "send_mcp_feedback",
        "get_inbox", "list_unread_threads", "read_thread", "get_attachment_text",
        "mark_thread_read", "send_email", "reply_to_thread",
      ]),
    );
  });

  it("a read-only OAuth token keeps mark_thread_read but loses send, setup, and domain writes", async () => {
    const client = await connect("/mcp", await oauthToken("read"));
    expect(await toolNames(client)).toEqual(
      without(ALL_TOOLS, "setup_agent_email", "send_email", "reply_to_thread", "create_inbox", "mint_inbox_key", "add_domain", "verify_domain"),
    );
  });

  it("an OAuth token with every scope matches the account-wide key", async () => {
    const client = await connect("/mcp", await oauthToken("read setup send domains"));
    expect(await toolNames(client)).toEqual(sorted(ALL_TOOLS));
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function rawInitialize(path: string, token: string) {
  return fetch(mcpBase + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
}

describe("authentication", () => {
  it("rejects an unknown om_ key with 401 and points at the protected-resource metadata", async () => {
    const res = await rawInitialize("/mcp", "om_not_a_real_key");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${MCP_RESOURCE}/.well-known/oauth-protected-resource"`,
    );
    expect((await res.json()).error).toBe("invalid_token");
    // The API was asked and said no — the MCP host did not guess.
    expect(api.calls("GET", /^\/v1\/me$/).map((r) => r.token)).toEqual(["om_not_a_real_key"]);
  });

  it("rejects a JWT signed with the wrong secret without contacting the API", async () => {
    const res = await rawInitialize("/mcp", await mcpJwt("read", { secret: "wrong-secret-wrong-secret-wrong!!" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(api.requests).toHaveLength(0);
  });

  it("rejects a JWT minted for a different audience", async () => {
    const res = await rawInitialize("/mcp", await mcpJwt("read", { aud: "https://other.example" }));
    expect(res.status).toBe(401);
  });

  it("rejects a bearer that is neither an om_ key nor a JWT", async () => {
    const res = await rawInitialize("/mcp", "garbage");
    expect(res.status).toBe(401);
    expect(api.requests).toHaveLength(0);
  });

  it("auth_me on an OAuth session reports the customer the API resolved", async () => {
    const client = await connect("/mcp", await oauthToken("read setup"));
    const result = await call(client, "auth_me");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("cust-1");
  });

  it("a validly-signed JWT whose grant the API has revoked is a 401 with resource metadata, not a tools/list", async () => {
    // Signature verifies, but the API no longer knows the grant → /v1/me is 401.
    const revoked = await mcpJwt("read setup send domains");
    const res = await rawInitialize("/mcp", revoked);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect((await res.json()).error).toBe("invalid_token");
    expect(api.calls("GET", /^\/v1\/me$/).map((r) => r.token)).toEqual([revoked]);

    // The real SDK client refuses to connect instead of half-working.
    await expect(connect("/mcp", revoked)).rejects.toMatchObject({ code: 401 });
  });

  it("a JWT the API answers with 403 is also unauthorized", async () => {
    api.state.meFailure = { status: 403, body: { error: "forbidden", message: "Grant disabled" } };
    const res = await rawInitialize("/mcp", await mcpJwt("read"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("an om_ key is a 503 upstream_unavailable, not a 401, when /v1/me is down", async () => {
    api.state.meFailure = { status: 503 };
    const res = await rawInitialize("/mcp", ACCOUNT_KEY);
    expect(res.status).toBe(503);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect((await res.json()).error).toBe("upstream_unavailable");
  });

  it("an OAuth token keeps serving from its own scopes when /v1/me is down", async () => {
    api.state.meFailure = { status: 503 };
    const client = await connect("/mcp", await mcpJwt("read"));
    expect(await toolNames(client)).toContain("read_thread");
    expect(await toolNames(client)).not.toContain("send_email");
  });
});

// ---------------------------------------------------------------------------
// Inbox lock enforcement
// ---------------------------------------------------------------------------

describe("inbox lock", () => {
  it("an inbox-scoped key cannot read a thread from another inbox", async () => {
    const client = await connect("/mcp", INBOX_A_KEY);
    const result = await call(client, "read_thread", { thread_id: "thread-b1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/cannot access that inbox/i);
  });

  it("an inbox-scoped key cannot reply into another inbox's thread, and nothing is sent", async () => {
    const client = await connect("/mcp", INBOX_A_KEY);
    const result = await call(client, "reply_to_thread", { thread_id: "thread-b1", body: "hi" });
    expect(result.isError).toBe(true);
    expect(api.calls("POST", /\/send$/)).toHaveLength(0);
  });

  it("a URL-locked session cannot mark another inbox's thread read", async () => {
    const client = await connect("/mcp/inbox/inbox-a", ACCOUNT_KEY);
    const result = await call(client, "mark_thread_read", { thread_id: "thread-b1" });
    expect(result.isError).toBe(true);
    expect(api.calls("PATCH", /^\/v1\/threads\//)).toHaveLength(0);
    expect(api.state.threads["thread-b1"].isRead).toBe(false);
  });

  it("a URL-locked session cannot read another inbox's attachment text", async () => {
    const client = await connect("/mcp/inbox/inbox-a", ACCOUNT_KEY);
    const result = await call(client, "get_attachment_text", { message_id: "msg-b1", filename: "other.pdf" });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("Secret from inbox B");
  });

  it("a URL-locked session refuses to send from another inbox instead of silently substituting", async () => {
    const client = await connect("/mcp/inbox/inbox-a", ACCOUNT_KEY);
    const result = await call(client, "send_email", {
      to: "x@example.com", subject: "s", body: "b", inbox_id: "inbox-b",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/cannot access that inbox/i);
    expect(api.calls("POST", /\/send$/)).toHaveLength(0);
  });

  it("an inbox-scoped key asking get_inbox for another inbox gets an error, not the locked inbox", async () => {
    const client = await connect("/mcp", INBOX_A_KEY);
    const result = await call(client, "get_inbox", { inbox_id: "inbox-b" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/cannot access that inbox/i);
    expect(result.text).not.toContain("a@omail.sh");
    expect(api.calls("GET", /^\/v1\/inboxes\/inbox-/)).toHaveLength(0);
  });

  it("a locked session still resolves the locked inbox when inbox_id is omitted or matches", async () => {
    const client = await connect("/mcp", INBOX_A_KEY);
    expect((await call(client, "get_inbox")).text).toContain("a@omail.sh");
    expect((await call(client, "get_inbox", { inbox_id: "inbox-a" })).isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mailbox loop
// ---------------------------------------------------------------------------

describe("mailbox tools", () => {
  it("reply_to_thread posts to the thread's inbox with the inbound sender and threadId", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    const result = await call(client, "reply_to_thread", { thread_id: "thread-a1", body: "Attached below." });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("thread-a1");

    const sends = api.calls("POST", /\/send$/);
    expect(sends).toHaveLength(1);
    expect(sends[0].path).toBe("/v1/inboxes/inbox-a/send");
    expect(sends[0].body).toEqual({ to: "human@example.com", body: "Attached below.", threadId: "thread-a1" });
    expect(sends[0].headers["x-openmail-client"]).toBe("mcp");
  });

  it("send_email and reply_to_thread forward cc and bcc, and omit them when empty", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);

    const sent = await call(client, "send_email", {
      to: "x@example.com", subject: "s", body: "b", inbox_id: "inbox-a",
      cc: ["c@example.com"], bcc: ["crm@example.com", "log@example.com"],
    });
    expect(sent.isError).toBe(false);

    const replied = await call(client, "reply_to_thread", {
      thread_id: "thread-a1", body: "r", bcc: ["crm@example.com"], cc: [],
    });
    expect(replied.isError).toBe(false);

    const sends = api.calls("POST", /\/send$/);
    expect(sends).toHaveLength(2);
    expect(sends[0].body).toEqual({
      to: "x@example.com", subject: "s", body: "b",
      cc: ["c@example.com"], bcc: ["crm@example.com", "log@example.com"],
    });
    expect(sends[1].body).toEqual({
      to: "human@example.com", body: "r", threadId: "thread-a1", bcc: ["crm@example.com"],
    });
  });

  it("list_unread_threads drops threads whose latest inbound is not autoReplyable", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    const result = await call(client, "list_unread_threads", { inbox_id: "inbox-a" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Invoice question");
    expect(result.text).not.toContain("Weekly newsletter");
    expect(api.calls("GET", /^\/v1\/inboxes\/inbox-a\/threads\?isRead=false/)).toHaveLength(1);
  });

  it("list_unread_threads without an inbox_id falls back to the first inbox", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    await call(client, "list_unread_threads");
    expect(api.calls("GET", /^\/v1\/inboxes\?limit=1$/)).toHaveLength(1);
    expect(api.calls("GET", /^\/v1\/inboxes\/inbox-a\/threads/)).toHaveLength(1);
  });

  it("read_thread renders the conversation with its autoReplyable flags", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    const result = await call(client, "read_thread", { thread_id: "thread-a1" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("human@example.com");
    expect(result.text).toContain("Where is my invoice?");
  });

  it("read_thread prints the message id next to attachments so get_attachment_text is reachable", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    const result = await call(client, "read_thread", { thread_id: "thread-a1" });
    expect(result.text).toContain("attachments: invoice.pdf");
    expect(result.text).toContain("message: msg-a1");
    // Round-trip: the id read_thread printed is the one the attachment tool accepts.
    const att = await call(client, "get_attachment_text", { message_id: "msg-a1", filename: "invoice.pdf" });
    expect(att.isError).toBe(false);
  });

  it("list_unread_threads names the inbox when it had to pick one", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    const picked = await call(client, "list_unread_threads");
    expect(picked.text).toContain("a@omail.sh");
    // Explicit inbox: caller already knows where it looked, so no scope line.
    const explicit = await call(client, "list_unread_threads", { inbox_id: "inbox-a" });
    expect(explicit.text).not.toContain("a@omail.sh");
  });

  it("send_email names the inbox it defaulted to, and stays quiet when told which one", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    const picked = await call(client, "send_email", { to: "x@example.com", subject: "Hi", body: "Hello" });
    expect(picked.isError).toBe(false);
    expect(picked.text).toContain("from: a@omail.sh");
    expect(picked.text).toContain("inbox_id");
    const explicit = await call(client, "send_email", { to: "x@example.com", subject: "Hi", body: "Hello", inbox_id: "inbox-b" });
    expect(explicit.text).not.toContain("from:");
    expect(api.calls("POST", /\/v1\/inboxes\/inbox-b\/send$/)).toHaveLength(1);
  });

  it("read_thread strips quoted history, shows timestamps and the autoReplyable flag", async () => {
    api.state.threads["thread-a1"].messages.push({
      id: "msg-a1b",
      direction: "inbound",
      fromAddr: "human@example.com",
      createdAt: "2026-09-25T11:42:00Z",
      autoReplyable: true,
      bodyText: "Thanks, got it.\n\nOn Fri, 25 Sep 2026 at 11:40, Agent <a@omail.sh>\nwrote:\n> Here is the invoice.\n> Regards\n",
    });
    const client = await connect("/mcp", ACCOUNT_KEY);
    const result = await call(client, "read_thread", { thread_id: "thread-a1" });
    expect(result.text).toContain("2026-09-25 11:42 UTC");
    expect(result.text).toContain("autoReplyable: yes");
    expect(result.text).toContain("Thanks, got it.");
    expect(result.text).not.toContain("Here is the invoice.");
    expect(result.text).not.toContain("wrote:");
  });

  it("tools carry annotations so clients can tell reads from sends", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.read_thread).toMatchObject({ readOnlyHint: true });
    expect(byName.list_inboxes).toMatchObject({ readOnlyHint: true });
    expect(byName.create_inbox).toMatchObject({ destructiveHint: false });
    expect(byName.send_email).toMatchObject({ destructiveHint: true, openWorldHint: true });
    for (const tool of tools) expect(tool.annotations?.title, tool.name).toBeTruthy();
  });

  it("setup_agent_email plan echoes the requested mailbox, domain, and display name", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    const result = await call(client, "setup_agent_email", { mailboxName: "release-bot", displayName: "Release Bot" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('release-bot@omail.sh "Release Bot"');
    expect(api.calls("POST", /^\/v1\/inboxes$/)).toHaveLength(0);
  });

  it("mark_thread_read flips the thread on the API", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    const result = await call(client, "mark_thread_read", { thread_id: "thread-a1" });
    expect(result.isError).toBe(false);
    expect(api.state.threads["thread-a1"].isRead).toBe(true);
  });

  it("get_attachment_text returns the extracted text for a permitted attachment", async () => {
    const client = await connect("/mcp", INBOX_A_KEY);
    const result = await call(client, "get_attachment_text", { message_id: "msg-a1", filename: "invoice.pdf" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Invoice #42 total 100 EUR");
  });

  it("surfaces API errors as isError results instead of protocol failures", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    const result = await call(client, "read_thread", { thread_id: "does-not-exist" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not found/i);
  });

  it("setup_agent_email with execute creates an inbox and mints a scoped key through the API", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    const result = await call(client, "setup_agent_email", { execute: true, mailboxName: "helper" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("helper@omail.sh");
    expect(result.text).toContain("om_minted_");
    expect(api.calls("POST", /^\/v1\/inboxes$/)).toHaveLength(1);
    expect(api.calls("POST", /^\/v1\/inboxes\/inbox-new-\d+\/api-keys$/)).toHaveLength(1);
  });

  // An OAuth session is a person's chat. A raw key returned there is exposed to
  // the transcript the moment it is minted, and the session does not need one.
  it("setup_agent_email over OAuth creates the inbox but never mints or prints a key", async () => {
    const client = await connect("/mcp", await oauthToken("read setup send domains"));
    const result = await call(client, "setup_agent_email", { execute: true, mailboxName: "helper" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("helper@omail.sh");
    expect(result.text).not.toContain("om_");
    expect(result.text).toContain("console.openmail.sh/settings");
    expect(api.calls("POST", /^\/v1\/inboxes$/)).toHaveLength(1);
    expect(api.calls("POST", /api-keys$/)).toHaveLength(0);
  });

  it("mint_inbox_key over OAuth points to the console instead of returning a token", async () => {
    const client = await connect("/mcp", await oauthToken("read setup send domains"));
    const result = await call(client, "mint_inbox_key", { inbox_id: "inbox-1" });
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("om_");
    expect(result.text).toContain("console.openmail.sh/settings");
    expect(api.calls("POST", /api-keys$/)).toHaveLength(0);
  });

  it("mint_inbox_key with an API key still returns the token (headless agent)", async () => {
    const client = await connect("/mcp", ACCOUNT_KEY);
    const result = await call(client, "mint_inbox_key", { inbox_id: "inbox-1" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("om_minted_");
    expect(api.calls("POST", /^\/v1\/inboxes\/inbox-1\/api-keys$/)).toHaveLength(1);
  });
});
