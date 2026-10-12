import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SessionContext, ToolName } from "./session.js";
import { assertLockedInbox, lockedInboxId, visibleTools } from "./session.js";
import { getDocs, searchDocs } from "./docs.js";
import { ApiError, type MeResponse, type OpenMailApi } from "./openmail.js";
import {
  formatApiError,
  formatDns,
  formatInbox,
  formatInboxes,
  formatMe,
  formatThread,
  formatThreads,
  formatSearch,
} from "./format.js";

function text(markdown: string, isError = false) {
  return { content: [{ type: "text" as const, text: markdown }], isError };
}

const CC_SCHEMA = z.array(z.string().email()).optional().describe("Visible copies.");
const BCC_SCHEMA = z
  .array(z.string().email())
  .optional()
  .describe("Blind copies, hidden from To and Cc. For CRM logging addresses (HubSpot, Salesforce).");

/** `cc`/`bcc` for a send body; empty lists are omitted so the request matches a plain send. */
function copies(args: { cc?: unknown; bcc?: unknown }): { cc?: string[]; bcc?: string[] } {
  const cc = args.cc as string[] | undefined;
  const bcc = args.bcc as string[] | undefined;
  return { ...(cc?.length ? { cc } : {}), ...(bcc?.length ? { bcc } : {}) };
}

/** Each unread thread costs one extra API read, so the page stays small. */
const UNREAD_MAX = 20;
/** No search endpoint yet: scan this many newest messages (100 per request). */
const SEARCH_SCAN = 500;
const SEARCH_MAX = 25;

type SearchHit = {
  id: string;
  threadId: string;
  direction: string;
  fromAddr: string;
  toAddr?: string;
  subject?: string | null;
  bodyText?: string | null;
  createdAt?: string;
};

const THREAD_ID = z
  .string()
  .describe("Required. Thread id from list_unread_threads or send_email output, not a message id.");
const DOMAIN_REF = z
  .string()
  .describe("Required. Domain id or name (e.g. mail.acme.com) from list_domains or add_domain.");
const POD_ID = z
  .string()
  .optional()
  .describe("Pod to create the inbox in. Needed when the custom domain is scoped to a pod; list_domains shows it.");

type DomainRow = { id: string; domain: string; status: string; podId?: string | null };

async function listDomains(api: OpenMailApi): Promise<DomainRow[]> {
  const listed = (await api.get("/v1/domains?limit=50")) as { data?: DomainRow[] };
  return listed.data ?? [];
}

/**
 * Agents pass the domain name as often as the id (list_domains used to print
 * only names), which 404'd. Accept either.
 */
async function resolveDomainId(api: OpenMailApi, ref: string): Promise<string> {
  if (!ref.includes(".")) return ref;
  const wanted = ref.trim().toLowerCase();
  const match = (await listDomains(api)).find((d) => d.domain.toLowerCase() === wanted);
  if (!match) throw new Error(`No domain named ${ref} on this account. Call list_domains, or add_domain to add it.`);
  return match.id;
}

/**
 * A custom domain scoped to a pod only works for inboxes in that pod; without
 * a podId the API uses the default pod and rejects it. Fill the pod in from
 * the domain itself so the caller does not have to know.
 */
async function podForDomain(
  api: OpenMailApi,
  domain: unknown,
  podId: unknown,
): Promise<string | undefined> {
  if (typeof podId === "string" && podId) return podId;
  if (typeof domain !== "string" || !domain) return undefined;
  const wanted = domain.trim().toLowerCase();
  // Best effort: if the lookup fails, let the create call report the real error.
  const rows = await listDomains(api).catch(() => [] as DomainRow[]);
  return rows.find((d) => d.domain.toLowerCase() === wanted)?.podId ?? undefined;
}

function consoleOrigin(): string {
  return (process.env.CONSOLE_ORIGIN || "https://console.openmail.sh").replace(/\/+$/, "");
}

/**
 * An OAuth session is a person chatting through a client (Claude, Cursor).
 * Anything a tool returns lands in that transcript, so a raw API key would be
 * exposed the moment it is minted — and the session does not need one: it is
 * already authenticated. Keys are for a *different*, headless agent, so send
 * the person to the console, where the token is shown once in the browser.
 */
function keyViaConsole(inbox: { address?: string | null }): string {
  const where = inbox.address ? ` scoped to ${inbox.address}` : "";
  return [
    "No key was minted: this session is signed in with OAuth, so it already has access, and a raw key returned here would sit in the chat transcript.",
    `If a separate agent needs its own key, mint one${where} in the console (shown once, in your browser): ${consoleOrigin()}/settings`,
  ].join("\n");
}

function fail(err: unknown) {
  if (err instanceof ApiError) return text(formatApiError(err), true);
  return text(err instanceof Error ? err.message : "Unexpected error", true);
}

function toolDesc(parts: {
  purpose: string;
  notFor: string;
  when: string;
  triggers: string;
}): string {
  return [
    `Purpose: ${parts.purpose}`,
    `NOT for: ${parts.notFor}`,
    `When to use: ${parts.when}`,
    `Trigger phrases: ${parts.triggers}`,
  ].join("\n");
}

type ThreadMessages = {
  threadId: string;
  inboxId: string;
  subject: string | null;
  data?: Array<{
    id: string;
    direction: string;
    fromAddr: string;
    toAddr?: string;
    createdAt?: string;
    bodyText?: string | null;
    autoReplyable?: boolean | null;
    category?: string | null;
    attachments?: Array<{ filename: string }>;
  }>;
};

async function loadThread(
  ctx: SessionContext,
  api: OpenMailApi,
  threadId: string,
): Promise<ThreadMessages> {
  const full = (await api.get(`/v1/threads/${threadId}/messages`)) as ThreadMessages;
  assertLockedInbox(ctx, full.inboxId);
  return full;
}

type ResolvedInbox = { id: string; address?: string | null; defaulted: boolean };

async function resolveInbox(
  ctx: SessionContext,
  api: OpenMailApi | null,
  requested?: string,
): Promise<ResolvedInbox> {
  const locked = lockedInboxId(ctx);
  if (locked) {
    // Never silently substitute: an explicit inbox_id that is not the locked
    // one is an error, so the caller learns its credential cannot see it.
    if (requested) assertLockedInbox(ctx, requested);
    return { id: locked, defaulted: false };
  }
  if (requested) return { id: requested, defaulted: false };
  if (!api) throw new Error("Sign in to OpenMail first.");
  const listed = (await api.get("/v1/inboxes?limit=1")) as {
    data?: Array<{ id: string; address?: string | null }>;
  };
  const first = listed.data?.[0];
  if (!first?.id) throw new Error("No inbox yet. Call setup_agent_email or create_inbox.");
  return { id: first.id, address: first.address, defaulted: true };
}

async function resolveInboxId(
  ctx: SessionContext,
  api: OpenMailApi | null,
  requested?: string,
): Promise<string> {
  return (await resolveInbox(ctx, api, requested)).id;
}

/**
 * Hints clients use to decide how much to ask the user before running a tool.
 * Without them ChatGPT and Claude treat every tool as a destructive write and
 * prompt on each call — including reads. Defaults (when a tool is omitted)
 * are the spec's: readOnly false, destructive true, idempotent false, open
 * world true.
 */
const TOOL_ANNOTATIONS: Record<ToolName, ToolAnnotations> = {
  search_docs: { title: "Search OpenMail docs", readOnlyHint: true, openWorldHint: false },
  get_docs: { title: "Fetch a docs page", readOnlyHint: true, openWorldHint: false },
  auth_me: { title: "Who am I", readOnlyHint: true, openWorldHint: false },
  send_mcp_feedback: { title: "Send feedback to OpenMail", destructiveHint: false, openWorldHint: false },
  list_inboxes: { title: "List inboxes", readOnlyHint: true, openWorldHint: false },
  get_inbox: { title: "Show inbox", readOnlyHint: true, openWorldHint: false },
  list_unread_threads: { title: "List unread threads", readOnlyHint: true, openWorldHint: false },
  read_thread: { title: "Read thread", readOnlyHint: true, openWorldHint: false },
  get_attachment_text: { title: "Read attachment", readOnlyHint: true, openWorldHint: false },
  list_domains: { title: "List domains", readOnlyHint: true, openWorldHint: false },
  get_domain: { title: "Show domain DNS", readOnlyHint: true, openWorldHint: false },
  // Creates something new; running it twice creates two. Not destructive.
  setup_agent_email: { title: "Set up agent inbox", destructiveHint: false, openWorldHint: false },
  create_inbox: { title: "Create inbox", destructiveHint: false, openWorldHint: false },
  mint_inbox_key: { title: "Mint inbox API key", destructiveHint: false, openWorldHint: false },
  add_domain: { title: "Add custom domain", destructiveHint: false, openWorldHint: false },
  verify_domain: { title: "Verify domain DNS", destructiveHint: false, idempotentHint: true, openWorldHint: false },
  mark_thread_read: { title: "Mark thread read", destructiveHint: false, idempotentHint: true, openWorldHint: false },
  search_mail: { title: "Search mail", readOnlyHint: true, openWorldHint: false },
  // Changes where inbound mail is copied: not destructive, but reaches outside.
  update_inbox: { title: "Update inbox settings", destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Thread delete moves to Trash (restorable 30 days); message delete does not.
  delete_thread: { title: "Delete thread", destructiveHint: true, idempotentHint: true, openWorldHint: false },
  delete_message: { title: "Delete message", destructiveHint: true, idempotentHint: true, openWorldHint: false },
  forward_message: { title: "Forward message", destructiveHint: true, openWorldHint: true },
  // Mail leaves the system and cannot be recalled: destructive + open world.
  send_email: { title: "Send email", destructiveHint: true, openWorldHint: true },
  reply_to_thread: { title: "Reply to thread", destructiveHint: true, openWorldHint: true },
};

export function createMcpServer(input: {
  ctx: SessionContext;
  api: OpenMailApi | null;
  me: MeResponse | null;
}): McpServer {
  const { ctx, api, me } = input;
  const allowed = new Set(visibleTools(ctx));
  const server = new McpServer({
    name: "openmail",
    version: "0.1.0",
    description:
      "OpenMail is Gmail for agents. Read autoReplyable mail (people and other agents; not spam, bulk, or bounces) and reply in-thread. Do not invent From addresses. Hosted URL: https://mcp.openmail.sh/mcp (sign in required; docs only at /mcp/public)",
  });

  const add = (
    name: ToolName,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
  ) => {
    if (!allowed.has(name)) return;
    server.registerTool(
      name,
      { description, inputSchema: schema, annotations: TOOL_ANNOTATIONS[name] },
      async (args) => {
        try {
          return await handler(args as Record<string, unknown>);
        } catch (err) {
          return fail(err);
        }
      },
    );
  };

  add(
    "search_docs",
    toolDesc({
      purpose: "Ranked OpenMail docs with citations.",
      notFor: "Reading a customer's mail or sending email.",
      when: "Before calling mailbox tools, or when unsure of an API field.",
      triggers: "how does openmail work, mcp setup, send email docs",
    }),
    { query: z.string().describe("Required. What you need to know, in a few words.") },
    async (args) => text(await searchDocs(String(args.query ?? ""))),
  );

  add(
    "get_docs",
    toolDesc({
      purpose: "Fetch one OpenMail docs page.",
      notFor: "Arbitrary web browsing.",
      when: "You have a docs.openmail.sh or openmail.sh URL from search_docs.",
      triggers: "open the quickstart, fetch llms.txt",
    }),
    {
      url: z
        .string()
        .optional()
        .describe("https://openmail.sh/... or https://docs.openmail.sh/..."),
    },
    async (args) => text(await getDocs(String(args.url ?? ""))),
  );

  add(
    "auth_me",
    toolDesc({
      purpose: "Who this credential is, and which inbox it can see.",
      notFor: "Listing other customers or switching orgs.",
      when: "First authenticated call, or after a 403.",
      triggers: "who am I, what can I access",
    }),
    {},
    async () => {
      if (!me) return text("Not signed in. Send a Bearer om_ key or complete OAuth.", true);
      return text(formatMe({ ...me, inboxId: ctx.inboxId || ctx.apiKeyInboxId }));
    },
  );

  add(
    "send_mcp_feedback",
    toolDesc({
      purpose: "Report a bug or friction in this MCP to OpenMail.",
      notFor: "Emailing a third party.",
      when: "A tool was confusing, wrong, or blocked you incorrectly.",
      triggers: "this tool is wrong, report friction",
    }),
    {
      message: z.string().describe("What went wrong or what you needed"),
      type: z.enum(["bug", "friction", "feature_request"]).optional(),
    },
    async (args) => {
      if (!api) return text("Sign in to send feedback.", true);
      await api.post("/v1/feedback", {
        type: args.type || "friction",
        message: args.message,
        context: { endpoint: "mcp" },
      });
      return text("Thanks — feedback recorded.");
    },
  );

  add(
    "setup_agent_email",
    toolDesc({
      purpose: "Plan (or execute) creating an inbox and minting a scoped key.",
      notFor: "Sending mail. Not for custom-domain DNS until you call add_domain.",
      when: "The agent has no inbox yet.",
      triggers: "give me an email address, set up inbox, mint a key",
    }),
    {
      execute: z
        .boolean()
        .optional()
        .describe("If true, create the inbox (and mint a key). Default false = plan only."),
      mailboxName: z.string().optional(),
      displayName: z.string().optional(),
      domain: z.string().optional(),
      pod_id: POD_ID,
      mintKey: z.boolean().optional().describe("Mint an inbox-scoped key. Default true when execute is true."),
    },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      if (!args.execute) {
        const mailbox = args.mailboxName ? String(args.mailboxName) : "(auto-generated)";
        const domain = args.domain ? String(args.domain) : "omail.sh";
        const display = args.displayName ? ` "${String(args.displayName)}"` : "";
        const keyStep =
          args.mintKey === false
            ? "skipped"
            : ctx.authKind === "oauth"
              ? "skipped — this session is already signed in; mint keys for other agents in the console"
              : "scoped key so this agent cannot see other inboxes";
        return text(
          [
            "Plan:",
            `1. create_inbox — ${mailbox}@${domain}${display}`,
            `2. mint_inbox_key — ${keyStep}`,
            "3. Optional add_domain + verify_domain for a custom domain",
            "4. list_unread_threads → read_thread → reply_to_thread",
            "",
            "Call again with execute=true and the same arguments to do steps 1–2.",
          ].join("\n"),
        );
      }
      const podId = await podForDomain(api, args.domain, args.pod_id);
      const inbox = (await api.post("/v1/inboxes", {
        mailboxName: args.mailboxName,
        displayName: args.displayName,
        domain: args.domain,
        ...(podId ? { podId } : {}),
      })) as { id: string; address: string; displayName?: string | null };
      let keyLine = "";
      if (args.mintKey !== false) {
        if (ctx.authKind === "oauth") {
          keyLine = `\n${keyViaConsole(inbox)}`;
        } else {
          const key = (await api.post(`/v1/inboxes/${inbox.id}/api-keys`, {
            name: "mcp",
          })) as { token?: string };
          if (key.token) {
            keyLine = `\nInbox-scoped key (shown once): \`${key.token}\`\nStore it in the agent's env (OPENMAIL_API_KEY); do not paste it into replies or docs.`;
          }
        }
      }
      return text(`${formatInbox(inbox)}${keyLine}`);
    },
  );

  add(
    "list_inboxes",
    toolDesc({
      purpose: "List inboxes this credential can see.",
      notFor: "Reading thread contents.",
      when: "You need an inbox id or address.",
      triggers: "what inboxes do I have",
    }),
    {},
    async () => {
      if (!api) return text("Sign in first.", true);
      const listed = (await api.get("/v1/inboxes?limit=50")) as {
        data: Array<{ id: string; address: string; displayName?: string | null }>;
      };
      return text(formatInboxes(listed.data ?? []));
    },
  );

  add(
    "get_inbox",
    toolDesc({
      purpose: "Show one inbox address.",
      notFor: "Reading mail.",
      when: "You already have an inbox id.",
      triggers: "show this inbox",
    }),
    { inbox_id: z.string().optional() },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const id = await resolveInboxId(ctx, api, args.inbox_id as string | undefined);
      const inbox = (await api.get(`/v1/inboxes/${id}`)) as {
        id: string;
        address: string;
        displayName?: string | null;
      };
      return text(formatInbox(inbox));
    },
  );

  add(
    "create_inbox",
    toolDesc({
      purpose: "Create a live agent inbox.",
      notFor: "Sending mail or adding DNS.",
      when: "setup_agent_email execute, or you need another address.",
      triggers: "create an inbox, new email address",
    }),
    {
      mailboxName: z.string().optional(),
      displayName: z.string().optional(),
      domain: z
        .string()
        .optional()
        .describe("omail.sh (default) or a verified custom domain from list_domains."),
      pod_id: POD_ID,
    },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const podId = await podForDomain(api, args.domain, args.pod_id);
      const inbox = (await api.post("/v1/inboxes", {
        mailboxName: args.mailboxName,
        displayName: args.displayName,
        domain: args.domain,
        ...(podId ? { podId } : {}),
      })) as { id: string; address: string; displayName?: string | null };
      return text(formatInbox(inbox));
    },
  );

  add(
    "mint_inbox_key",
    toolDesc({
      purpose:
        "Mint an API key locked to one inbox. Token is shown once. OAuth sessions are sent to the console instead, so the token never enters the chat.",
      notFor: "Account-wide keys. Not needed for this session — it is already authenticated.",
      when: "Handing a key to a separate headless agent or CI.",
      triggers: "mint a scoped key, inbox api key",
    }),
    {
      inbox_id: z.string().optional(),
      name: z.string().optional(),
    },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const inbox = await resolveInbox(ctx, api, args.inbox_id as string | undefined);
      if (ctx.authKind === "oauth") return text(keyViaConsole(inbox));
      const key = (await api.post(`/v1/inboxes/${inbox.id}/api-keys`, {
        name: args.name || "mcp",
      })) as { token?: string; last4?: string };
      if (!key.token) return text("Key created but token was not returned.");
      return text(
        `Inbox-scoped key (shown once): \`${key.token}\`\nStore it in the agent's env (OPENMAIL_API_KEY); do not paste it into replies or docs.`,
      );
    },
  );

  add(
    "send_email",
    toolDesc({
      purpose: "Start a new thread from the agent's inbox.",
      notFor: "Replies — use reply_to_thread so threading stays intact.",
      when: "Outbound mail with no existing thread.",
      triggers: "send an email, email this person",
    }),
    {
      to: z.string().email(),
      subject: z.string(),
      body: z.string(),
      cc: CC_SCHEMA,
      bcc: BCC_SCHEMA,
      inbox_id: z
        .string()
        .optional()
        .describe("Inbox to send from. Omit only when the account has one inbox; otherwise call list_inboxes and pass the right id."),
    },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const inbox = await resolveInbox(ctx, api, args.inbox_id as string | undefined);
      const sent = (await api.post(`/v1/inboxes/${inbox.id}/send`, {
        to: args.to,
        subject: args.subject,
        body: args.body,
        ...copies(args),
      })) as { id?: string; threadId?: string; from?: string };
      // Say which address the mail left from when we chose it: the agent
      // (and the person reading the transcript) should never have to guess.
      const from = inbox.defaulted
        ? `\nfrom: ${inbox.address || inbox.id} (default inbox — pass inbox_id to send from another)`
        : "";
      return text(
        `Sent to ${args.to}${from}${sent.threadId ? `\nthread: ${sent.threadId}` : ""}`,
      );
    },
  );

  add(
    "reply_to_thread",
    toolDesc({
      purpose: "Reply in-thread from the same inbox.",
      notFor: "Starting a new conversation.",
      when: "You have a thread id from list_unread_threads or read_thread.",
      triggers: "reply, answer this email",
    }),
    {
      thread_id: THREAD_ID,
      body: z.string(),
      cc: CC_SCHEMA,
      bcc: BCC_SCHEMA,
      inbox_id: z.string().optional(),
    },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const thread = await loadThread(ctx, api, String(args.thread_id));
      const messages = [...(thread.data ?? [])].reverse();
      // A follow-up on a thread the agent started has no inbound yet: reply
      // to whoever the last outbound went to instead of failing.
      const to =
        messages.find((m) => m.direction === "inbound")?.fromAddr ??
        messages.find((m) => m.direction === "outbound" && m.toAddr)?.toAddr;
      if (!to) return text("This thread has no recipient to reply to. Use send_email to start a new thread.", true);
      await api.post(`/v1/inboxes/${thread.inboxId}/send`, {
        to,
        body: args.body,
        threadId: args.thread_id,
        ...copies(args),
      });
      return text(`Replied on thread ${args.thread_id}`);
    },
  );

  add(
    "list_unread_threads",
    toolDesc({
      purpose: "Unread threads whose latest message is autoReplyable: from a person or another agent, not machine-generated.",
      notFor: "Spam, marketing, or bounces — those are filtered out.",
      when: "The mailbox loop: what needs a reply.",
      triggers: "unread mail, anything that needs a reply",
    }),
    {
      inbox_id: z.string().optional(),
      limit: z
        .number()
        .int()
        .optional()
        .describe(`How many threads to check, 1–${UNREAD_MAX}. Larger values are capped at ${UNREAD_MAX}. Default 10.`),
    },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const inbox = await resolveInbox(ctx, api, args.inbox_id as string | undefined);
      const id = inbox.id;
      // Clamp instead of rejecting: agents ask for 50 or 100, and a schema
      // error there cost them the whole call.
      const limit = Math.min(UNREAD_MAX, Math.max(1, Number(args.limit ?? 10) || 10));
      const listed = (await api.get(
        `/v1/inboxes/${id}/threads?isRead=false&limit=${limit}`,
      )) as {
        data: Array<{ id: string; subject: string | null; lastMessageAt: string }>;
      };
      const rows = [];
      for (const thread of listed.data ?? []) {
        const full = await loadThread(ctx, api, thread.id);
        const inbound = [...(full.data ?? [])]
          .reverse()
          .find((m) => m.direction === "inbound");
        if (inbound && inbound.autoReplyable === false) continue;
        rows.push({
          id: thread.id,
          subject: thread.subject,
          from: inbound?.fromAddr,
          lastMessageAt: thread.lastMessageAt,
        });
      }
      // Only name the inbox when we picked it: an explicit inbox_id or a
      // locked key already tells the caller where it looked.
      return text(formatThreads(rows, inbox.defaulted ? inbox : undefined));
    },
  );

  add(
    "read_thread",
    toolDesc({
      purpose: "Full thread as markdown, with autoReplyable flags.",
      notFor: "Finding a thread you do not have the id of (use search_mail).",
      when: "Before replying.",
      triggers: "read this thread, show the conversation",
    }),
    { thread_id: THREAD_ID },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const full = await loadThread(ctx, api, String(args.thread_id));
      return text(
        formatThread({
          threadId: full.threadId,
          subject: full.subject,
          messages: full.data ?? [],
        }),
      );
    },
  );

  add(
    "mark_thread_read",
    toolDesc({
      purpose: "Mark a thread read after you have handled it.",
      notFor: "Deleting mail.",
      when: "You replied or decided no reply is needed.",
      triggers: "mark as read, archive this",
    }),
    { thread_id: THREAD_ID },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      await loadThread(ctx, api, String(args.thread_id));
      await api.patch(`/v1/threads/${args.thread_id}`, { isRead: true });
      return text(`Marked ${args.thread_id} read.`);
    },
  );

  add(
    "search_mail",
    toolDesc({
      purpose: `Find messages by words in the subject, body, sender, or recipient. Scans the newest ${SEARCH_SCAN} messages of one inbox.`,
      notFor: "Searching the docs (use search_docs).",
      when: "You need an older thread or message and do not have its id.",
      triggers: "find the email from, search my mail, where is the invoice",
    }),
    {
      query: z.string().describe("Required. Words to match; every word must appear (case-insensitive)."),
      inbox_id: z.string().optional(),
      direction: z.enum(["inbound", "outbound"]).optional().describe("Only received or only sent mail."),
      limit: z.number().int().optional().describe(`Max results, 1–${SEARCH_MAX}. Default 10.`),
    },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const words = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) return text("Pass a query, e.g. `invoice acme`.", true);
      const inbox = await resolveInbox(ctx, api, args.inbox_id as string | undefined);
      const max = Math.min(SEARCH_MAX, Math.max(1, Number(args.limit ?? 10) || 10));
      const hits: SearchHit[] = [];
      let scanned = 0;
      let total = 0;
      // The API has no search endpoint yet; page newest-first and stop early.
      for (let offset = 0; offset < SEARCH_SCAN && hits.length < max; offset += 100) {
        const params = new URLSearchParams({ limit: "100", offset: String(offset) });
        if (args.direction) params.set("direction", String(args.direction));
        const page = (await api.get(`/v1/inboxes/${inbox.id}/messages?${params}`)) as {
          data?: SearchHit[];
          total?: number;
        };
        const rows = page.data ?? [];
        total = page.total ?? total;
        scanned += rows.length;
        for (const m of rows) {
          const hay = [m.subject, m.fromAddr, m.toAddr, m.bodyText].filter(Boolean).join("\n").toLowerCase();
          if (words.every((w) => hay.includes(w))) hits.push(m);
          if (hits.length >= max) break;
        }
        if (rows.length < 100) break;
      }
      return text(formatSearch(hits, { query: String(args.query), scanned, total, inbox: inbox.defaulted ? inbox : undefined }));
    },
  );

  add(
    "forward_message",
    toolDesc({
      purpose: "Forward one message to another address, as a new thread from the same inbox.",
      notFor: "Replying to the sender (use reply_to_thread). Not for forwarding all future mail (use update_inbox).",
      when: "Someone else needs to see a message you received.",
      triggers: "forward this email, send this to my colleague",
    }),
    {
      thread_id: THREAD_ID,
      message_id: z
        .string()
        .optional()
        .describe("The `message:` id from read_thread. Omit to forward the latest inbound message."),
      to: z.string().email(),
      note: z.string().optional().describe("Text above the forwarded message."),
      cc: CC_SCHEMA,
      bcc: BCC_SCHEMA,
    },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const thread = await loadThread(ctx, api, String(args.thread_id));
      const messages = thread.data ?? [];
      const msg = args.message_id
        ? messages.find((m) => m.id === args.message_id)
        : [...messages].reverse().find((m) => m.direction === "inbound") ?? messages[messages.length - 1];
      if (!msg) {
        return text(
          args.message_id
            ? `Message ${args.message_id} is not in thread ${args.thread_id}. Call read_thread for its message ids.`
            : `Thread ${args.thread_id} has no messages to forward.`,
          true,
        );
      }
      const subject = thread.subject ?? "";
      const files = msg.attachments?.map((a) => a.filename) ?? [];
      const body = [
        ...(args.note ? [String(args.note), ""] : []),
        "---------- Forwarded message ----------",
        `From: ${msg.fromAddr}`,
        ...(msg.createdAt ? [`Date: ${msg.createdAt}`] : []),
        `Subject: ${subject}`,
        ...(msg.toAddr ? [`To: ${msg.toAddr}`] : []),
        "",
        msg.bodyText ?? "",
        ...(files.length ? ["", `[Attachments not included: ${files.join(", ")}]`] : []),
      ].join("\n");
      const sent = (await api.post(`/v1/inboxes/${thread.inboxId}/send`, {
        to: args.to,
        subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`.trim(),
        body,
        ...copies(args),
      })) as { threadId?: string };
      const note = files.length ? `\nAttachments were not forwarded: ${files.join(", ")}` : "";
      return text(`Forwarded ${msg.id} to ${args.to}${sent.threadId ? `\nthread: ${sent.threadId}` : ""}${note}`);
    },
  );

  add(
    "update_inbox",
    toolDesc({
      purpose: "Change an inbox's display name or auto-forwarding (copy inbound mail to another address).",
      notFor: "Forwarding one message (use forward_message).",
      when: "The user wants inbound mail copied to their own address, or forwarding stopped.",
      triggers: "forward all mail to my gmail, stop forwarding, rename inbox",
    }),
    {
      inbox_id: z.string().optional(),
      display_name: z.string().nullable().optional(),
      forward_to: z
        .string()
        .email()
        .nullable()
        .optional()
        .describe("Address that gets a copy of inbound mail. null stops forwarding. Addresses outside the organisation must confirm by email first."),
      forward_when: z
        .enum(["always", "needs_human", "webhook_failed"])
        .optional()
        .describe("always (default); needs_human = only mail the agent should not auto-handle; webhook_failed = only when webhook delivery failed."),
    },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const patch: Record<string, unknown> = {};
      if (args.display_name !== undefined) patch.displayName = args.display_name;
      if (args.forward_to !== undefined) patch.forwardTo = args.forward_to;
      if (args.forward_when !== undefined) patch.forwardWhen = args.forward_when;
      if (Object.keys(patch).length === 0) {
        return text("Nothing to change. Pass display_name, forward_to, or forward_when.", true);
      }
      const id = await resolveInboxId(ctx, api, args.inbox_id as string | undefined);
      const inbox = (await api.patch(`/v1/inboxes/${id}`, patch)) as {
        id: string;
        address: string;
        displayName?: string | null;
        forwardTo?: string | null;
        forwardWhen?: string | null;
        forwardStatus?: string | null;
      };
      const fwd = inbox.forwardTo
        ? `\nforwarding: ${inbox.forwardTo} (${inbox.forwardWhen ?? "always"}, ${inbox.forwardStatus ?? "pending"})${
            inbox.forwardStatus === "pending" ? "\nNothing is forwarded until the address clicks the confirmation link we emailed." : ""
          }`
        : "\nforwarding: off";
      return text(`${formatInbox(inbox)}${fwd}`);
    },
  );

  add(
    "delete_thread",
    toolDesc({
      purpose: "Move a thread and all its messages to Trash. Restorable from the console for 30 days.",
      notFor: "Marking handled mail (use mark_thread_read).",
      when: "The user asks to delete a conversation.",
      triggers: "delete this thread, trash this conversation",
    }),
    { thread_id: THREAD_ID },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      await loadThread(ctx, api, String(args.thread_id));
      await api.delete(`/v1/threads/${args.thread_id}`);
      return text(`Moved thread ${args.thread_id} to Trash (restorable in the console for 30 days).`);
    },
  );

  add(
    "delete_message",
    toolDesc({
      purpose: "Delete one message from a thread. Not restorable.",
      notFor: "Deleting a whole conversation (use delete_thread, which can be undone).",
      when: "The user asks to remove one specific message.",
      triggers: "delete this message",
    }),
    {
      thread_id: THREAD_ID,
      message_id: z.string().describe("Required. The `message:` id from read_thread."),
    },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      // Load through the thread so an inbox-locked session cannot reach
      // a message in another inbox by id.
      const thread = await loadThread(ctx, api, String(args.thread_id));
      if (!thread.data?.some((m) => m.id === args.message_id)) {
        return text(`Message ${args.message_id} is not in thread ${args.thread_id}. Call read_thread for its message ids.`, true);
      }
      await api.delete(`/v1/messages/${args.message_id}`);
      return text(`Deleted message ${args.message_id}.`);
    },
  );

  add(
    "get_attachment_text",
    toolDesc({
      purpose: "LLM-ready text extracted from an attachment.",
      notFor: "Downloading raw bytes.",
      when: "read_thread listed an attachment; use the `message:` id printed under it, not the thread id.",
      triggers: "read the pdf, extract the invoice",
    }),
    {
      message_id: z.string().describe("The `message:` id shown under the attachment in read_thread"),
      filename: z.string(),
    },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const extracted = (await api.get(
        `/v1/attachments/${args.message_id}/${encodeURIComponent(String(args.filename))}/text`,
      )) as { text?: string; filename?: string; inboxId?: string };
      assertLockedInbox(ctx, extracted.inboxId);
      return text(`# ${extracted.filename || args.filename}\n\n${extracted.text || ""}`);
    },
  );

  add(
    "list_domains",
    toolDesc({
      purpose: "Custom sending/receiving domains and their verify status.",
      notFor: "Platform omail.sh addresses.",
      when: "Checking whether DNS is green.",
      triggers: "list domains, is my domain verified",
    }),
    {},
    async () => {
      if (!api) return text("Sign in first.", true);
      const rows = await listDomains(api);
      if (rows.length === 0) return text("No custom domains.");
      return text(
        rows
          .map((d) => `- ${d.domain} (${d.status}) id: ${d.id}${d.podId ? ` pod: ${d.podId}` : ""}`)
          .join("\n"),
      );
    },
  );

  add(
    "get_domain",
    toolDesc({
      purpose: "One domain with pasteable DNS records.",
      notFor: "Editing DNS at the registrar.",
      when: "You have a domain id from list_domains or add_domain.",
      triggers: "show dns records",
    }),
    { domain_id: DOMAIN_REF },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const domain = (await api.get(`/v1/domains/${await resolveDomainId(api, String(args.domain_id))}`)) as {
        domain: string;
        status: string;
        records: Array<{
          type: string;
          name: string;
          value: string;
          purpose?: string;
          status?: string;
          priority?: number | null;
        }>;
      };
      return text(formatDns(domain));
    },
  );

  add(
    "add_domain",
    toolDesc({
      purpose: "Start custom-domain setup and return pasteable DNS.",
      notFor: "Creating an inbox (do that after verify).",
      when: "The agent needs a branded address.",
      triggers: "add my domain, set up mail.example.com",
    }),
    { domain: z.string() },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const domain = (await api.post("/v1/domains", { domain: args.domain })) as {
        id?: string;
        domain: string;
        status: string;
        records: Array<{
          type: string;
          name: string;
          value: string;
          purpose?: string;
          status?: string;
          priority?: number | null;
        }>;
      };
      const idLine = domain.id ? `\n\ndomain id: ${domain.id}` : "";
      return text(`${formatDns(domain)}${idLine}`);
    },
  );

  add(
    "verify_domain",
    toolDesc({
      purpose: "Recheck DNS after the records were published.",
      notFor: "Guessing records — call get_domain if you need them again.",
      when: "The user says DNS is saved.",
      triggers: "verify domain, check dns",
    }),
    { domain_id: DOMAIN_REF },
    async (args) => {
      if (!api) return text("Sign in first.", true);
      const domain = (await api.post(`/v1/domains/${await resolveDomainId(api, String(args.domain_id))}/verify`)) as {
        domain: string;
        status: string;
        records: Array<{
          type: string;
          name: string;
          value: string;
          purpose?: string;
          status?: string;
          priority?: number | null;
        }>;
      };
      return text(formatDns(domain));
    },
  );

  return server;
}
