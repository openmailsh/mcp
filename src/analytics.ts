import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { instrument, PostHogMCPAnalyticsProperty, type BeforeSendFn } from "@posthog/mcp";
import { PostHog } from "posthog-node";
import type { MeResponse } from "./openmail.js";
import type { SessionContext } from "./session.js";

/**
 * PostHog MCP Analytics: one `$mcp_tool_call` per tool call (tool, client,
 * latency, error, intent), plus `$mcp_initialize` / `$mcp_tools_list`.
 * Same project and env names as the API (`POSTHOG_API_KEY`, `POSTHOG_HOST`);
 * unset key = analytics off, which is what local dev and tests want.
 */
let client: PostHog | null | undefined;

export function posthogClient(): PostHog | null {
  if (client !== undefined) return client;
  const key = process.env.POSTHOG_API_KEY;
  client = key
    ? new PostHog(key, { host: process.env.POSTHOG_HOST || "https://eu.i.posthog.com" })
    : null;
  return client;
}

export async function shutdownAnalytics(): Promise<void> {
  await client?.shutdown();
}

/**
 * Tool results are mostly customer mail (thread bodies, attachments) or
 * secrets (minted keys). Only the public-docs tools return anything safe to
 * keep. Everything else drops `$mcp_response`; the SDK's own sanitizer is a
 * backstop, not a policy.
 */
const KEEP_RESPONSE: ReadonlySet<string> = new Set(["search_docs", "get_docs"]);

/** Argument names that carry mail content or personal data, never analytics. */
const CONTENT_ARGS: ReadonlySet<string> = new Set([
  "to",
  "cc",
  "bcc",
  "subject",
  "body",
  "message",
  "mailboxName",
  "displayName",
]);

/**
 * Strip content keys at any depth: the SDK records parameters as the whole
 * JSON-RPC request (`request.params.arguments.body`), not just the arguments,
 * and that shape is not something we should couple to.
 */
function stripContentKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripContentKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (CONTENT_ARGS.has(key)) delete record[key];
    else stripContentKeys(record[key]);
  }
}

export const redactMailContent: BeforeSendFn = (event) => {
  const props = event.properties;
  const tool = props[PostHogMCPAnalyticsProperty.ToolName];
  if (typeof tool !== "string" || !KEEP_RESPONSE.has(tool)) {
    delete props[PostHogMCPAnalyticsProperty.Response];
  }
  stripContentKeys(props[PostHogMCPAnalyticsProperty.Parameters]);
  return event;
};

function serverBuild(): string | undefined {
  // Railway sets RAILWAY_GIT_COMMIT_SHA on every deploy.
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA;
  return sha ? sha.slice(0, 12) : undefined;
}

export function instrumentServer(
  server: McpServer,
  input: { ctx: SessionContext; me: MeResponse | null },
): void {
  const posthog = posthogClient();
  if (!posthog) return;
  const { ctx, me } = input;

  instrument(server, posthog, {
    serverBuild: serverBuild(),
    // Our own send_mcp_feedback tool already covers this.
    reportMissing: false,
    // Would append a JSON block to every tool result; session correlation
    // comes from the Mcp-Session-Id token instead (needs JSON responses).
    enableConversationId: false,
    // Matches the API: the org is the distinct id. Anonymous (docs-only) sessions stay anonymous.
    identify: me
      ? { distinctId: me.customerId, properties: { plan: me.plan } }
      : null,
    eventProperties: () => ({
      auth_kind: ctx.authKind,
      readonly: ctx.readonly,
      inbox_locked: Boolean(ctx.inboxId || ctx.apiKeyInboxId),
      toolsets: [...ctx.toolsets].sort().join(","),
      ...(ctx.scopes ? { scopes: [...ctx.scopes].sort().join(" ") } : {}),
    }),
    beforeSend: redactMailContent,
    // The SDK logs every captured event at this level; only useful when debugging.
    ...(process.env.MCP_ANALYTICS_DEBUG
      ? { logger: (message: string) => console.warn(`[mcp analytics] ${message}`) }
      : {}),
  });
}
