# OpenMail MCP

Hosted Streamable HTTP MCP at `https://mcp.openmail.sh/mcp`. Email inbox for AI agents: one inbox, read mail that wants a reply, reply in-thread.

Attachments: `get_attachment` returns the file (images as image content, other files as an embedded resource, 4 MB inline limit). `get_attachment_text` returns extracted text only.

There is **no local stdio catalog** — stdio-only clients should use `mcp-remote`.

## Connect

**Claude (OAuth):** paste `https://mcp.openmail.sh/mcp`

**Cursor (OAuth):** [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=openmail&config=eyJ1cmwiOiJodHRwczovL21jcC5vcGVubWFpbC5zaC9tY3AifQ==), or add the URL below without `headers`. Also on [cursor.directory](https://cursor.directory/plugins/openmail) as a plugin (`.cursor-plugin/plugin.json` + `mcp.json`).

**Claude Code:** `claude mcp add --transport http openmail https://mcp.openmail.sh/mcp`, or install as a plugin (`claude plugin marketplace add openmailsh/mcp`, then `claude plugin install openmail@openmailsh-mcp`): the plugin bundles the server with the `openmail` skill, which teaches the agent when to reach for email and how to handle a thread. The plugin lives in `plugin/` and holds only Markdown, JSON and the logo: the Claude directory refuses code files from unverified organisations, so keep code out of it.

**VS Code / any registry client:** listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `sh.openmail/openmail`.

**Cursor or headless agents (API key):**

```json
{
  "mcpServers": {
    "openmail": {
      "url": "https://mcp.openmail.sh/mcp",
      "headers": { "Authorization": "Bearer om_YOUR_KEY" }
    }
  }
}
```

Prefer an inbox-scoped key. Read-only: `/mcp/readonly`. One inbox: `/mcp/inbox/{id}`.

Keys and transcripts: over OAuth (Claude, Cursor sign-in) `setup_agent_email` and `mint_inbox_key` never return a token — the session is already authenticated, and anything returned lands in the chat. They point to the console, which shows a new key once in the browser. Over an API key (headless agent) the token is returned in the tool result; move it to the agent's env.

**stdio-only clients:** `npx -y mcp-remote https://mcp.openmail.sh/mcp`

## Drafts

Use `create_draft` to save an unsent email, then `list_drafts` and `get_draft` to review it. Drafts belong to the organisation. Sending inbox, recipient, subject and body are optional; account-wide connections can save drafts before an inbox exists. `list_drafts` lists all accessible drafts and accepts an optional inbox filter; `get_draft` needs only `draft_id`. Draft creation requires OAuth `send` scope (or an API key) and is unavailable on read-only connections. Reading drafts is available on read-only connections. Inbox locks apply to every draft tool. Saving a draft never sends it; the console can select a sending inbox, edit recipients and subject, and send drafts.

To send a saved draft, read it with `get_draft`, then call `send_draft` with its `draft_id`, exact `updated_at`, and `inbox_id` to select a sender (or omit the inbox to use the saved selection). Sending requires the user’s instruction and OAuth `send` scope (or an API key). Read-only connections cannot send. Stale versions must be reviewed again; failed sends retain the draft.

## Plugin packages

The Codex/OpenAI, Claude, and Cursor plugins connect to the same hosted MCP server and use the shared `skills/openmail/SKILL.md` instructions. Their draft workflow is `create_draft` → `list_drafts` / `get_draft` → `send_draft` after approval.

Build the OpenAI submission ZIP with `bash scripts/package-openai-plugin.sh`. It includes the updated manifest, shared skill, assets, and OpenAI OAuth configuration. Deploy the draft API and MCP server before publishing updated plugin packages; existing connections may need to refresh their tool list.

## Env

| Name | Purpose |
| --- | --- |
| `OPENMAIL_API_URL` | API origin (`https://api.openmail.sh`) |
| `MCP_RESOURCE_URL` | OAuth resource (`https://mcp.openmail.sh`) |
| `MCP_JWT_SECRET` | Same secret as the API. Required in production; outside production falls back to `NEXTAUTH_SECRET` |
| `CONSOLE_ORIGIN` | Consent page host |
| `PORT` | Listen port |
| `POSTHOG_API_KEY` | Turns on [PostHog MCP Analytics](https://posthog.com/docs/mcp-analytics) (`$mcp_tool_call` per call). Unset = off |
| `MCP_ANALYTICS_DEBUG` | Set to log every captured analytics event |

See `.env.example`.

## Local

```
pnpm install
pnpm test
pnpm dev
```

## Contributing

Open an issue or PR. Run `pnpm typecheck && pnpm test` before pushing.

MIT © OpenMail
