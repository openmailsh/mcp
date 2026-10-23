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
  formatSearch,
  formatTimestamp,
} from "./format.js";

function text(markdown: string, isError = false) {
  return { content: [{ type: "text" as const, text: markdown }], isError };
}

const CC_SCHEMA = z.array(z.string().email()).optional().describe("People to copy on the email. Every recipient sees who was copied.");
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
  .describe("Thread id from list_unread_threads, search_mail, or send_email output, not a message id.");
const DOMAIN_REF = z
  .string()
  .describe("Domain id or name (e.g. mail.acme.com) from list_domains or add_domain.");
const POD_ID = z
  .string()
  .optional()
  .describe("Pod to create the inbox in; list_domains shows each domain's pod. Omit to use the custom domain's pod, or the default pod for omail.sh.");
const MAILBOX_NAME = z
  .string()
  .optional()
  .describe("Local part of the new address (the `support` in support@omail.sh). Omit to auto-generate one.");
const DISPLAY_NAME = z
  .string()
  .optional()
  .describe("Sender name recipients see next to the address, e.g. `Acme Support`. Omit to create the inbox without one; recipients then see only the address.");
const INBOX_DOMAIN = z
  .string()
  .optional()
  .describe("omail.sh (default) or a verified custom domain from list_domains.");
const INBOX_ID = z
  .string()
  .optional()
  .describe("Inbox id from list_inboxes. Omit to use the session's locked inbox, or else the account's first inbox.");

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
  if (!match) throw new Error(`There's no domain called ${ref} on this account. Check the domain list, or add it first.`);
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
  return text(err instanceof Error ? err.message : "Something went wrong. Try again in a moment.", true);
}

const SIGN_IN = "You're not signed in to OpenMail. Connect your OpenMail account (or add an API key) and try again.";
const signIn = () => text(SIGN_IN, true);

function toolDesc(parts: {
  purpose: string;
  notFor: string;
  when: string;
  triggers: string;
  /** What the markdown result contains, so the agent knows it answers the request. */
  returns?: string;
}): string {
  return [
    `Purpose: ${parts.purpose}`,
    ...(parts.returns ? [`Returns: ${parts.returns}`] : []),
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
  if (!api) throw new Error(SIGN_IN);
  const listed = (await api.get("/v1/inboxes?limit=1")) as {
    data?: Array<{ id: string; address?: string | null }>;
  };
  const first = listed.data?.[0];
  if (!first?.id) throw new Error("This account has no inbox yet. Create one first, then try again.");
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
 * prompt on each call — including reads. Every hint is set explicitly so no
 * client falls back to the spec defaults (destructive, open world).
 */
const hints = (
  title: string,
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
): ToolAnnotations => ({ title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint });
/** GETs against the OpenMail API (or its docs): no state change, safe to repeat. */
const read = (title: string) => hints(title, true, false, true, false);

const TOOL_ANNOTATIONS: Record<ToolName, ToolAnnotations> = {
  search_docs: read("Search OpenMail docs"),
  get_docs: read("Fetch a docs page"),
  auth_me: read("Who am I"),
  list_inboxes: read("List inboxes"),
  get_inbox: read("Show inbox"),
  list_unread_threads: read("List unread threads"),
  read_thread: read("Read thread"),
  get_attachment_text: read("Read attachment"),
  list_domains: read("List domains"),
  get_domain: read("Show domain DNS"),
  search_mail: read("Search mail"),
  // Creates something new; running it twice creates two. Not destructive.
  send_mcp_feedback: hints("Send feedback to OpenMail", false, false, false, false),
  setup_agent_email: hints("Set up agent inbox", false, false, false, false),
  create_inbox: hints("Create inbox", false, false, false, false),
  mint_inbox_key: hints("Mint inbox API key", false, false, false, false),
  add_domain: hints("Add custom domain", false, false, false, false),
  // Updates stored status / read flag; repeating converges on the same state.
  verify_domain: hints("Verify domain DNS", false, false, true, false),
  mark_thread_read: hints("Mark thread read", false, false, true, false),
  // Changes where inbound mail is copied: not destructive, but reaches outside.
  update_inbox: hints("Update inbox settings", false, false, true, true),
  // Thread delete moves to Trash (restorable 30 days); message delete does not.
  delete_thread: hints("Delete thread", false, true, true, false),
  delete_message: hints("Delete message", false, true, true, false),
  // Mail leaves the system and cannot be recalled: destructive + open world.
  forward_message: hints("Forward message", false, true, false, true),
  send_email: hints("Send email", false, true, false, true),
  reply_to_thread: hints("Reply to thread", false, true, false, true),
};

/** Sent in `initialize`: how an agent should drive this server. */
export const SERVER_INSTRUCTIONS = [
  "OpenMail gives the agent its own email inboxes.",
  "Start with auth_me to see which credential and inbox you have. No inbox yet: setup_agent_email (plan first, then execute=true).",
  "Mailbox loop: list_unread_threads → read_thread → reply_to_thread → mark_thread_read. It lists machine mail too; only reply to threads marked autoReplyable: yes.",
  "For the latest or most recent email, call list_unread_threads with include_read: true. It lists machine mail too, flagged autoReplyable: no.",
  "Use reply_to_thread for replies and send_email only for new conversations. Pass inbox_id when the account has more than one inbox (list_inboxes).",
  "Never invent From addresses or paste API keys into chat. Custom domains: add_domain → user publishes DNS → verify_domain.",
  "Unsure how something works: search_docs, then get_docs.",
].join("\n");

export function createMcpServer(input: {
  ctx: SessionContext;
  api: OpenMailApi | null;
  me: MeResponse | null;
}): McpServer {
  const { ctx, api, me } = input;
  const allowed = new Set(visibleTools(ctx));
  const server = new McpServer(
    {
      name: "openmail",
      title: "OpenMail",
      version: "0.1.0",
      description:
        "OpenMail is an email inbox for AI agents. Read autoReplyable mail (people and other agents; not spam, bulk, or bounces) and reply in-thread. Do not invent From addresses. Hosted URL: https://mcp.openmail.sh/mcp (sign in required; docs only at /mcp/public)",
      websiteUrl: "https://openmail.sh",
      icons: [{ src: "https://openmail.sh/apple-touch-icon.png", mimeType: "image/png", sizes: ["180x180"] }],
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const add = (
    name: ToolName,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
  ) => {
    if (!allowed.has(name)) return;
    server.registerTool(
      name,
      { title: TOOL_ANNOTATIONS[name].title, description, inputSchema: schema, annotations: TOOL_ANNOTATIONS[name] },
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
      returns: "Up to 5 matching docs sections, each with its title, source URL, and an excerpt.",
    }),
    {
      query: z
        .string()
        .describe("The topic or question to look up in the OpenMail docs, e.g. `verify custom domain` or `inbox api key`. Ranked by keyword match."),
    },
    async (args) => text(await searchDocs(String(args.query ?? ""))),
  );

  add(
    "get_docs",
    toolDesc({
      purpose: "Fetch one OpenMail docs page.",
      notFor: "Arbitrary web browsing.",
      when: "You have a docs.openmail.sh or openmail.sh URL from search_docs.",
      triggers: "open the quickstart, fetch llms.txt",
      returns: "The page text (markdown when available), cut off after 20,000 characters.",
    }),
    {
      url: z
        .string()
        .optional()
        .describe("Page to fetch, usually a Source URL from search_docs. Only openmail.sh and docs.openmail.sh pages work. Omit for the OpenMail llms.txt overview."),
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
      returns: "Customer id, plan, API key scope, OAuth scopes (if any), and the locked inbox id when the credential is limited to one inbox.",
    }),
    {},
    async () => {
      if (!me) return signIn();
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
      returns: "A short confirmation that the feedback was recorded.",
    }),
    {
      message: z.string().describe("What went wrong or what you needed"),
      type: z
        .enum(["bug", "friction", "feature_request"])
        .optional()
        .describe("Kind of report: a tool gave a wrong result (bug), worked but was confusing or slow (friction), or a capability is missing (feature_request). Omit to file it as friction."),
    },
    async (args) => {
      if (!api) return signIn();
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
        .describe("Omit or false to only preview the plan. true creates the inbox (and mints a key)."),
      mailboxName: MAILBOX_NAME,
      displayName: DISPLAY_NAME,
      domain: INBOX_DOMAIN,
      pod_id: POD_ID,
      mintKey: z.boolean().optional().describe("Mint an inbox-scoped key. Default true when execute is true."),
    },
    async (args) => {
      if (!api) return signIn();
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
      returns: "Each inbox's address, display name, and id. Up to 50 inboxes.",
    }),
    {},
    async () => {
      if (!api) return signIn();
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
      returns: "The inbox's address, display name, and id.",
    }),
    { inbox_id: INBOX_ID },
    async (args) => {
      if (!api) return signIn();
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
      returns: "The new inbox's address, display name, and id.",
    }),
    {
      mailboxName: MAILBOX_NAME,
      displayName: DISPLAY_NAME,
      domain: INBOX_DOMAIN,
      pod_id: POD_ID,
    },
    async (args) => {
      if (!api) return signIn();
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
      inbox_id: INBOX_ID,
      name: z.string().optional().describe("Label for the key so you can recognise it in the console later. Default `mcp`."),
    },
    async (args) => {
      if (!api) return signIn();
      const inbox = await resolveInbox(ctx, api, args.inbox_id as string | undefined);
      if (ctx.authKind === "oauth") return text(keyViaConsole(inbox));
      const key = (await api.post(`/v1/inboxes/${inbox.id}/api-keys`, {
        name: args.name || "mcp",
      })) as { token?: string; last4?: string };
      if (!key.token) return text("The key was created, but OpenMail didn't return it. Create a new one in the console: " + consoleOrigin() + "/settings");
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
      to: z.string().email().describe("Who the new email is for."),
      subject: z.string().describe("Subject line of the new thread."),
      body: z.string().describe("Plain-text message body."),
      cc: CC_SCHEMA,
      bcc: BCC_SCHEMA,
      unsubscribe: z
        .boolean()
        .optional()
        .describe(
          "Set true for cold outreach. Adds one-click unsubscribe headers (Gmail/Outlook show an Unsubscribe button) and fills {{unsubscribe_url}} in the body. A click suppresses the recipient account-wide. Only works with no cc or bcc.",
        ),
      inbox_id: z
        .string()
        .optional()
        .describe("Inbox to send from. Omit only when the account has one inbox; otherwise call list_inboxes and pass the right id."),
    },
    async (args) => {
      if (!api) return signIn();
      const inbox = await resolveInbox(ctx, api, args.inbox_id as string | undefined);
      const sent = (await api.post(`/v1/inboxes/${inbox.id}/send`, {
        to: args.to,
        subject: args.subject,
        body: args.body,
        ...copies(args),
        ...(args.unsubscribe ? { unsubscribe: true } : {}),
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
      body: z.string().describe("Plain-text reply. It goes to the latest inbound sender (or, with none, the last outbound recipient)."),
      cc: CC_SCHEMA,
      bcc: BCC_SCHEMA,
      inbox_id: z
        .string()
        .optional()
        .describe("Not needed: the reply always goes out from the thread's own inbox."),
    },
    async (args) => {
      if (!api) return signIn();
      const thread = await loadThread(ctx, api, String(args.thread_id));
      const messages = [...(thread.data ?? [])].reverse();
      // A follow-up on a thread the agent started has no inbound yet: reply
      // to whoever the last outbound went to instead of failing.
      const to =
        messages.find((m) => m.direction === "inbound")?.fromAddr ??
        messages.find((m) => m.direction === "outbound" && m.toAddr)?.toAddr;
      if (!to) return text("There's no one to reply to in this thread yet. Start a new email instead.", true);
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
      purpose: "Newest unread threads in one inbox, everything included: mail from people and agents, and machine mail such as verification codes, receipts, newsletters, and bounces. Each thread is flagged autoReplyable yes or no.",
      notFor: "Replying to machine mail: only reply to threads marked autoReplyable: yes.",
      when: "The mailbox loop, or the user asks for new, latest, or most recent email. Pass include_read for the latest mail whether read or not.",
      triggers: "unread mail, anything that needs a reply, my last email, latest email, what came in, did I get a code",
      returns: "Each thread's subject, latest inbound sender, read or unread, time, autoReplyable flag, and thread id.",
    }),
    {
      inbox_id: INBOX_ID,
      include_read: z.boolean().optional().describe("Also list threads already read, e.g. for 'my last email'. Omit for unread only."),
      limit: z
        .number()
        .int()
        .optional()
        .describe(`How many threads to return, newest first. Values above ${UNREAD_MAX} are treated as ${UNREAD_MAX}. Omit for 10.`),
    },
    async (args) => {
      if (!api) return signIn();
      const inbox = await resolveInbox(ctx, api, args.inbox_id as string | undefined);
      // Clamp instead of rejecting: agents ask for 50 or 100, and a schema
      // error there cost them the whole call.
      const limit = Math.min(UNREAD_MAX, Math.max(1, Number(args.limit ?? 10) || 10));
      const unreadOnly = !args.include_read;
      const params = new URLSearchParams();
      if (unreadOnly) params.set("isRead", "false");
      params.set("limit", String(limit));
      const listed = (await api.get(`/v1/inboxes/${inbox.id}/threads?${params}`)) as {
        data: Array<{ id: string; subject: string | null; isRead: boolean; lastMessageAt: string }>;
      };
      // Name the inbox: "nothing" on an account key is otherwise ambiguous.
      const scope = inbox.address || inbox.id;
      const kind = unreadOnly ? "unread threads" : "threads";
      const threads = listed.data ?? [];
      if (threads.length === 0) {
        return text(`No ${kind} in ${scope}.`);
      }
      const lines = [`Newest ${kind} in ${scope}:`];
      for (const thread of threads) {
        const full = await loadThread(ctx, api, thread.id);
        const inbound = [...(full.data ?? [])].reverse().find((m) => m.direction === "inbound");
        const from = inbound?.fromAddr ? ` from ${inbound.fromAddr}` : "";
        const state = thread.isRead ? "read" : "unread";
        const reply = inbound ? `, autoReplyable: ${inbound.autoReplyable === false ? "no" : "yes"}` : "";
        lines.push(
          `- ${thread.subject || "(no subject)"}${from}\n  ${state}, ${thread.lastMessageAt}${reply}\n  thread: ${thread.id}`,
        );
      }
      return text(lines.join("\n"));
    },
  );

  add(
    "read_thread",
    toolDesc({
      purpose: "Full thread as markdown, with autoReplyable flags.",
      notFor: "Finding a thread you do not have the id of (use search_mail).",
      when: "Before replying.",
      triggers: "read this thread, show the conversation",
      returns: "Subject, thread id, then each message: direction, sender, time, message id, category, autoReplyable flag, body (quoted history stripped), and attachment names.",
    }),
    { thread_id: THREAD_ID },
    async (args) => {
      if (!api) return signIn();
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
      if (!api) return signIn();
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
      returns: "How many messages were scanned, then each match: subject, sender or recipient, time, thread id, message id, and a short body snippet.",
    }),
    {
      query: z.string().describe("Words to look for in the subject, body, sender, or recipient. A message matches only if it contains every word; case is ignored."),
      inbox_id: INBOX_ID,
      direction: z.enum(["inbound", "outbound"]).optional().describe("Restrict results to mail this inbox received (inbound) or sent (outbound). Omit to search both."),
      limit: z.number().int().optional().describe(`How many matching messages to return. Values above ${SEARCH_MAX} are treated as ${SEARCH_MAX}. Omit for 10.`),
    },
    async (args) => {
      if (!api) return signIn();
      const words = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) return text("Enter some words to search for, e.g. `invoice acme`.", true);
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
      returns: "Which message was forwarded and to whom, the new thread id, and any attachments that were not included.",
    }),
    {
      thread_id: THREAD_ID,
      message_id: z
        .string()
        .optional()
        .describe("The `message:` id from read_thread. Omit to forward the latest inbound message."),
      to: z.string().email().describe("Address to forward the message to."),
      note: z.string().optional().describe("Text above the forwarded message."),
      cc: CC_SCHEMA,
      bcc: BCC_SCHEMA,
    },
    async (args) => {
      if (!api) return signIn();
      const thread = await loadThread(ctx, api, String(args.thread_id));
      const messages = thread.data ?? [];
      const msg = args.message_id
        ? messages.find((m) => m.id === args.message_id)
        : [...messages].reverse().find((m) => m.direction === "inbound") ?? messages[messages.length - 1];
      if (!msg) {
        return text(
          args.message_id
            ? `That message isn't in this thread. Open the thread to see its messages.`
            : "This thread has no messages to forward.",
          true,
        );
      }
      const subject = thread.subject ?? "";
      const files = msg.attachments?.map((a) => a.filename) ?? [];
      const body = [
        ...(args.note ? [String(args.note), ""] : []),
        "---------- Forwarded message ----------",
        `From: ${msg.fromAddr}`,
        ...(msg.createdAt ? [`Date: ${formatTimestamp(msg.createdAt) || msg.createdAt}`] : []),
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
      returns: "The inbox's address, display name, and id, plus forwarding target, mode, and confirmation status (or off).",
    }),
    {
      inbox_id: INBOX_ID,
      display_name: z
        .string()
        .nullable()
        .optional()
        .describe("New sender name recipients see. null clears it; omit to leave it unchanged."),
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
      if (!api) return signIn();
      const patch: Record<string, unknown> = {};
      if (args.display_name !== undefined) patch.displayName = args.display_name;
      if (args.forward_to !== undefined) patch.forwardTo = args.forward_to;
      if (args.forward_when !== undefined) patch.forwardWhen = args.forward_when;
      if (Object.keys(patch).length === 0) {
        return text("Nothing to change. Give a new display name or forwarding setting.", true);
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
      returns: "Confirmation that the thread was moved to Trash.",
    }),
    { thread_id: THREAD_ID },
    async (args) => {
      if (!api) return signIn();
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
      returns: "Confirmation that the message was deleted.",
    }),
    {
      thread_id: THREAD_ID,
      message_id: z.string().describe("The `message:` id from read_thread."),
    },
    async (args) => {
      if (!api) return signIn();
      // Load through the thread so an inbox-locked session cannot reach
      // a message in another inbox by id.
      const thread = await loadThread(ctx, api, String(args.thread_id));
      if (!thread.data?.some((m) => m.id === args.message_id)) {
        return text(`That message isn't in this thread. Open the thread to see its messages.`, true);
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
      returns: "The attachment's extracted text under its filename.",
    }),
    {
      message_id: z.string().describe("The `message:` id shown under the attachment in read_thread"),
      filename: z.string().describe("Attachment filename exactly as listed after `attachments:` in read_thread."),
    },
    async (args) => {
      if (!api) return signIn();
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
      returns: "Each custom domain's name, verify status, id, and pod id (if scoped). Up to 50 domains.",
    }),
    {},
    async () => {
      if (!api) return signIn();
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
      returns: "Domain name, verify status, and each DNS record (type, name, value, priority, purpose, per-record status).",
    }),
    { domain_id: DOMAIN_REF },
    async (args) => {
      if (!api) return signIn();
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
      returns: "Domain name, status, the DNS records to publish at the registrar, and the new domain id.",
    }),
    {
      domain: z
        .string()
        .describe("Domain or subdomain to send and receive mail on, e.g. mail.acme.com. The user must be able to edit its DNS."),
    },
    async (args) => {
      if (!api) return signIn();
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
      returns: "Domain name, updated verify status, and each DNS record with its own status.",
    }),
    { domain_id: DOMAIN_REF },
    async (args) => {
      if (!api) return signIn();
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
