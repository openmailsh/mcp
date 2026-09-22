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
    return `No unread human/auto-replyable threads${scope}.`;
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
    const skip =
      message.direction === "inbound" && message.autoReplyable === false
        ? " — skip (not auto-replyable)"
        : "";
    lines.push(`## ${message.direction} from ${from}${skip}`);
    if (message.category) lines.push(`category: ${message.category}`);
    lines.push(clip(message.bodyText || "(empty body)", 6000));
    if (message.attachments?.length) {
      // The message id is the handle get_attachment_text needs; without it an
      // agent has nothing to pass but the thread id, which 404s.
      lines.push(
        `attachments: ${message.attachments.map((a) => a.filename).join(", ")}`,
        `message: ${message.id} (pass as message_id to get_attachment_text)`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trim();
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

export function formatApiError(err: {
  status: number;
  code: string;
  message: string;
}): string {
  return `OpenMail API ${err.status} (${err.code}): ${err.message}`;
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
- Reply to unread mail from humans.
- Add and verify mail.example.com.
`;
