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

const sorted = (names: readonly string[]) => [...names].sort();
const without = (names: readonly string[], ...drop: string[]) => sorted(names.filter((n) => !drop.includes(n)));

const WRITE_TOOLS = ["send_email", "reply_to_thread", "mark_thread_read", "create_inbox", "mint_inbox_key", "add_domain", "verify_domain"];

// ---------------------------------------------------------------------------
// Tool surface per endpoint / credential
// ---------------------------------------------------------------------------

describe("tools/list", () => {
  it("unauthenticated sessions see only the docs tools", async () => {
    const client = await connect("/mcp");
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
    const client = await connect("/mcp", await mcpJwt("read"));
    expect(await toolNames(client)).toEqual(
      without(ALL_TOOLS, "send_email", "reply_to_thread", "create_inbox", "mint_inbox_key", "add_domain", "verify_domain"),
    );
  });

  it("an OAuth token with every scope matches the account-wide key", async () => {
    const client = await connect("/mcp", await mcpJwt("read setup send domains"));
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
    const token = await mcpJwt("read setup");
    // The API recognises this JWT (as the real one would via the grant).
    api.state.tokens[token] = api.state.tokens[ACCOUNT_KEY];
    const client = await connect("/mcp", token);
    const result = await call(client, "auth_me");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("cust-1");
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

  it("a URL-locked session sends from the locked inbox even if the tool asks for another", async () => {
    const client = await connect("/mcp/inbox/inbox-a", ACCOUNT_KEY);
    const result = await call(client, "send_email", {
      to: "x@example.com", subject: "s", body: "b", inbox_id: "inbox-b",
    });
    expect(result.isError).toBe(false);
    expect(api.calls("POST", /\/send$/).map((r) => r.path)).toEqual(["/v1/inboxes/inbox-a/send"]);
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
});
