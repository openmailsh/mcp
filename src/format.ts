function clip(text: string, max = 4000): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n\n…truncated`;
}

export function formatInboxes(
  rows: Array<{ id: string; address: string; displayName?: string | null }>,
): string {
  if (rows.length === 0) return "No inboxes.";
  return rows
    .map((row) => {
      const name = row.displayName ? ` (${row.displayName})` : "";
      return `- ${row.address}${name}\n  id: ${row.id}`;
    })
    .join("\n");
}

export function formatInbox(row: {
  id: string;
  address: string;
  displayName?: string | null;
}): string {
  const name = row.displayName ? `\nName: ${row.displayName}` : "";
  return `Address: ${row.address}${name}\nId: ${row.id}`;
}

export function formatThreads(
  rows: Array<{
    id: string;
    subject: string | null;
    from?: string;
    autoReplyable?: boolean | null;
    lastMessageAt?: string;
  }>,
  inbox?: { id: string; address?: string | null },
): string {
  // Name the inbox that was scanned. Without it, "no threads" on an account
  // key is ambiguous: none anywhere, or none in whichever inbox was picked.
  const scope = inbox ? ` in ${inbox.address || inbox.id}` : "";
  if (rows.length === 0) {
    return `No unread threads that need a reply${scope}.`;
  }
  const header = inbox ? [`Unread${scope}:`] : [];
  return [
    ...header,
    ...rows.map((row) => {
      const subject = row.subject || "(no subject)";
      const from = row.from ? ` from ${row.from}` : "";
      return `- ${subject}${from}\n  thread: ${row.id}`;
    }),
  ].join("\n");
}

export function formatThread(thread: {
  threadId: string;
  subject?: string | null;
  messages: Array<{
    id: string;
    direction: string;
    fromAddr?: string;
    from?: string;
    toAddr?: string;
    createdAt?: string;
    bodyText?: string | null;
    subject?: string | null;
    autoReplyable?: boolean | null;
    category?: string | null;
    attachments?: Array<{ filename: string }>;
  }>;
}): string {
  const lines = [
    `# ${thread.subject || "(no subject)"}`,
    `thread: ${thread.threadId}`,
    "",
  ];
  for (const message of thread.messages) {
    const from = message.fromAddr || message.from || "unknown";
    const when = formatTimestamp(message.createdAt);
    const to = message.direction === "outbound" && message.toAddr ? ` to ${message.toAddr}` : "";
    lines.push(`## ${message.direction} from ${from}${to}${when ? ` — ${when}` : ""}`);
    // Every message's id: forward_message, delete_message, and
    // get_attachment_text all take it.
    const meta: string[] = [`message: ${message.id}`];
    if (message.category) meta.push(`category: ${message.category}`);
    if (message.direction === "inbound" && message.autoReplyable != null) {
      meta.push(
        message.autoReplyable
          ? "autoReplyable: yes"
          : "autoReplyable: no — skip, do not reply",
      );
    }
    if (meta.length) lines.push(meta.join(" · "));
    lines.push(clip(stripQuotedReply(message.bodyText || "") || "(empty body)", 6000));
    if (message.attachments?.length) {
      lines.push(
        `attachments: ${message.attachments.map((a) => a.filename).join(", ")} (get_attachment_text with message_id ${message.id})`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function formatSearch(
  hits: Array<{
    id: string;
    threadId: string;
    direction: string;
    fromAddr: string;
    toAddr?: string;
    subject?: string | null;
    bodyText?: string | null;
    createdAt?: string;
  }>,
  info: { query: string; scanned: number; total: number; inbox?: { id: string; address?: string | null } },
): string {
  const scope = info.inbox ? ` in ${info.inbox.address || info.inbox.id}` : "";
  // Say how far back we looked, so "no results" is not read as "never existed".
  const coverage =
    info.total > info.scanned
      ? `Searched the newest ${info.scanned} of ${info.total} messages${scope}.`
      : `Searched all ${info.scanned} messages${scope}.`;
  if (hits.length === 0) return `No messages match "${info.query}". ${coverage}`;
  return [
    coverage,
    ...hits.map((m) => {
      const who = m.direction === "outbound" ? `to ${m.toAddr ?? "?"}` : `from ${m.fromAddr}`;
      const when = formatTimestamp(m.createdAt);
      const snippet = (m.bodyText ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
      return [
        `- ${m.subject || "(no subject)"} ${who}${when ? ` — ${when}` : ""}`,
        `  thread: ${m.threadId} · message: ${m.id}`,
        ...(snippet ? [`  ${snippet}`] : []),
      ].join("\n");
    }),
  ].join("\n");
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // 2026-09-25 11:42 UTC — sortable, unambiguous, short.
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// Where mail clients start the quoted history of a reply. Each message in a
// thread is already shown on its own, so the quote only repeats what the agent
// has just read (and burns context).
const QUOTE_MARKERS: RegExp[] = [
  // Gmail / Apple Mail: "On Fri, 25 Sep 2026 at 11:42, Jane <j@x.com> wrote:"
  // The header can wrap so "wrote:" sits alone on the next line — only whitespace
  // is allowed before it there, or ordinary prose like "I wrote:" would cut the reply.
  /^On [^\n]*(?:\n\s*)?wrote:\s*$/m,
  // Outlook
  /^-{2,}\s*Original Message\s*-{2,}\s*$/mi,
  /^_{5,}\s*$/m,
  /^From:\s[^\n]*\n(?:Sent|Date):\s/m,
  // Localised Gmail
  /^Le [^\n]* a écrit\s*:\s*$/m,
  /^Am [^\n]* schrieb [^\n]*:\s*$/m,
  /^El [^\n]* escribió:\s*$/m,
];

/** Drop the quoted history a reply carries; keep the new text on top. */
export function stripQuotedReply(body: string): string {
  let cut = body.length;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(body);
    if (match && match.index < cut) cut = match.index;
  }
  let head = body.slice(0, cut);
  // A trailing block of `>` lines is quoted too, even without a marker —
  // but only if there is something unquoted above it to keep.
  const unquoted = head.replace(/(?:^|\n)[ \t]*>[^\n]*(?=\n|$)/g, "");
  if (unquoted.trim()) head = head.replace(/(?:\n[ \t]*>[^\n]*)+\s*$/, "");
  head = head.trim();
  // Never hide the whole message: a body that is nothing but a quote is
  // still the only text there is.
  return head || body.trim();
}

export function formatDns(domain: {
  domain: string;
  status: string;
  records?: Array<{
    type: string;
    name: string;
    value: string;
    purpose?: string;
    status?: string;
    priority?: number | null;
  }>;
}): string {
  const lines = [
    `# ${domain.domain}`,
    `status: ${domain.status}`,
    "",
    "Paste these DNS records at your registrar:",
    "",
  ];
  for (const record of domain.records ?? []) {
    const prio =
      record.priority != null ? ` (priority ${record.priority})` : "";
    lines.push(
      `- ${record.type} ${record.name} → ${record.value}${prio}`,
    );
    if (record.purpose || record.status) {
      lines.push(
        `  ${[record.purpose, record.status].filter(Boolean).join(" · ")}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * The next step for errors agents hit in production (PostHog $mcp_tool_call).
 * Batch senders hit the new-recipient cap mid-batch and were told only "try
 * after midnight"; one asked support how to raise it. Give them the numbers
 * and the ways forward.
 */
function errorHint(code: string, body: unknown): string | null {
  const b = (body ?? {}) as { resetsAt?: unknown; limit?: unknown; scope?: unknown };
  switch (code) {
    case "cold_outreach_limit": {
      const limit = typeof b.limit === "number" && b.limit > 0 ? `${b.limit} new recipients a day` : "a daily new-recipient limit";
      const scope = typeof b.scope === "string" ? ` per ${b.scope}` : "";
      const until = typeof b.resetsAt === "string" ? b.resetsAt : "midnight UTC";
      return [
        `Limit: ${limit}${scope}. Resets ${until}.`,
        "Only first contact to an address that never wrote this inbox counts. Replies (reply_to_thread) and follow-ups to people already emailed still send now.",
        "Hold the remaining new recipients until the reset; retrying before then fails the same way.",
        "To raise the limit: upgrade the plan at https://console.openmail.sh/settings/billing, or ask support@openmail.sh for a review.",
      ].join("\n");
    }
    case "reputation_suspended":
      return "Do not retry: every send from here fails until support lifts the suspension. Tell the user to contact support@openmail.sh. Reading mail still works.";
    case "invalid_domain":
      return "Call list_domains: only domains shown as verified work, and a domain scoped to a pod needs that pod_id. Omit domain to use omail.sh.";
    default:
      return null;
  }
}

export function formatApiError(err: {
  status: number;
  code: string;
  message: string;
  body?: unknown;
}): string {
  const line = `OpenMail API ${err.status} (${err.code}): ${err.message}`;
  const hint = errorHint(err.code, err.body);
  return hint ? `${line}\n${hint}` : line;
}

export function formatMe(me: {
  customerId: string;
  plan: string;
  apiKeyScope: unknown;
  mcpScopes: string[] | null;
  inboxId?: string | null;
}): string {
  const scope =
    typeof me.apiKeyScope === "string"
      ? me.apiKeyScope
      : JSON.stringify(me.apiKeyScope);
  const lines = [
    `customer: ${me.customerId}`,
    `plan: ${me.plan}`,
    `api key scope: ${scope}`,
  ];
  if (me.mcpScopes) lines.push(`oauth scopes: ${me.mcpScopes.join(", ")}`);
  if (me.inboxId) lines.push(`locked inbox: ${me.inboxId}`);
  return lines.join("\n");
}

export const INSTALL_MARKDOWN = `# OpenMail MCP

Gmail for agents. Hosted at \`https://mcp.openmail.sh/mcp\`.

## Claude / OAuth

Paste this URL. Sign in, grant **read** (always) and optionally **send**.

\`\`\`
https://mcp.openmail.sh/mcp
\`\`\`

## Cursor / API key

\`\`\`json
{
  "mcpServers": {
    "openmail": {
      "url": "https://mcp.openmail.sh/mcp",
      "headers": { "Authorization": "Bearer om_YOUR_KEY" }
    }
  }
}
\`\`\`

Prefer an **inbox-scoped** key so the agent cannot see other inboxes.

## Read-only / one inbox

- \`https://mcp.openmail.sh/mcp/readonly\`
- \`https://mcp.openmail.sh/mcp?readonly=true\`
- \`https://mcp.openmail.sh/mcp/inbox/INBOX_ID\`
- \`?toolsets=mailbox,docs\`
- \`https://mcp.openmail.sh/mcp/public\` — docs only, no sign-in

## Old stdio-only clients

Hosted HTTP is the product. Bridge with:

\`\`\`json
{
  "mcpServers": {
    "openmail": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.openmail.sh/mcp"]
    }
  }
}
\`\`\`

## Example prompts

- Set up an inbox for this agent and show me the address.
- Reply to unread mail that needs an answer.
- Add and verify mail.example.com.
`;
