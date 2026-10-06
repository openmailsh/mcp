/**
 * PostHog MCP Analytics: every tool call becomes a `$mcp_tool_call`, tied to
 * the customer, with mail content stripped before it leaves the process.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PostHog } from "posthog-node";
import { redactMailContent } from "../analytics.js";
import { startFakeOpenMailApi, type FakeOpenMailApi, type FakeState } from "./helpers/fake-openmail-api.js";

const ACCOUNT_KEY = "om_account_key";

function seed(): FakeState {
  return {
    tokens: {
      [ACCOUNT_KEY]: { customerId: "cust-1", plan: "developer", apiKeyScope: "account", mcpScopes: null },
    },
    inboxes: [{ id: "inbox-a", address: "a@omail.sh", displayName: "A" }],
    threads: {},
    attachments: {},
  };
}

type Captured = { event: string; distinctId?: string; properties?: Record<string, unknown> };

let api: FakeOpenMailApi;
let mcpServer: http.Server;
let mcpBase: string;
let captured: Captured[] = [];

beforeAll(async () => {
  api = await startFakeOpenMailApi(seed());
  process.env.OPENMAIL_API_URL = api.url;
  process.env.MCP_JWT_SECRET = "test-mcp-secret-at-least-32-chars-long!!";
  process.env.MCP_RESOURCE_URL = "https://mcp.openmail.sh";
  // Any key turns analytics on; capture is intercepted so nothing is sent.
  process.env.POSTHOG_API_KEY = "phc_test";
  vi.spyOn(PostHog.prototype, "capture").mockImplementation(function (this: PostHog, msg) {
    captured.push(msg as Captured);
  });
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
  vi.restoreAllMocks();
});

beforeEach(() => {
  api.reset(seed());
  captured = [];
});

const openClients: Client[] = [];
afterEach(async () => {
  await Promise.all(openClients.splice(0).map((c) => c.close().catch(() => {})));
});

async function connect(token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), {
    requestInit: { headers },
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  openClients.push(client);
  return client;
}

/** Events are captured after the tool result is sent; give the sink a tick. */
async function toolCalls(): Promise<Captured[]> {
  for (let i = 0; i < 20 && !captured.some((c) => c.event === "$mcp_tool_call"); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return captured.filter((c) => c.event === "$mcp_tool_call");
}

describe("redactMailContent", () => {
  const event = (tool: string, params: Record<string, unknown>) => ({
    distinct_id: "cust-1",
    event: "$mcp_tool_call",
    properties: { $mcp_tool_name: tool, $mcp_parameters: { ...params }, $mcp_response: "secret" },
  });

  it("drops the response and mail-content arguments for mailbox tools, however deep", () => {
    const out = redactMailContent(
      event("send_email", {
        request: { params: { arguments: { to: "x@example.com", subject: "Hi", body: "Where is my invoice?", inbox_id: "inbox-a" } } },
      }),
    ) as ReturnType<typeof event>;
    expect(out.properties.$mcp_response).toBeUndefined();
    expect(out.properties.$mcp_parameters).toEqual({ request: { params: { arguments: { inbox_id: "inbox-a" } } } });
  });

  it("keeps the response for the public docs tools", () => {
    const out = redactMailContent(event("search_docs", { query: "send email" })) as ReturnType<typeof event>;
    expect(out.properties.$mcp_response).toBe("secret");
    expect(out.properties.$mcp_parameters).toEqual({ query: "send email" });
  });
});

describe("tool calls are captured", () => {
  it("records the tool, the customer, and session context without mail content", async () => {
    const client = await connect(ACCOUNT_KEY);
    await client.callTool({
      name: "send_email",
      arguments: { to: "human@example.com", subject: "Hello", body: "Private body", inbox_id: "inbox-a" },
    });

    const calls = await toolCalls();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.distinctId).toBe("cust-1");
    expect(call.properties).toMatchObject({
      $mcp_tool_name: "send_email",
      $mcp_is_error: false,
      $mcp_client_name: "test-client",
      auth_kind: "api_key",
      readonly: false,
      inbox_locked: false,
    });
    expect(call.properties?.$mcp_response).toBeUndefined();
    const json = JSON.stringify(call);
    expect(json).toContain('"inbox_id":"inbox-a"');
    expect(json).not.toContain("Private body");
    expect(json).not.toContain("human@example.com");
    expect(json).not.toContain("Hello");
  });

  it("marks failed calls as errors", async () => {
    const client = await connect(ACCOUNT_KEY);
    await client.callTool({ name: "read_thread", arguments: { thread_id: "nope" } });
    const [call] = await toolCalls();
    expect(call.properties?.$mcp_tool_name).toBe("read_thread");
    expect(call.properties?.$mcp_is_error).toBe(true);
  });
});
