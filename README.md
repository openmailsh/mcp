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

Use `create_draft` with the sending `inbox_id`. A connection locked to an inbox supplies its own ID. The owner is fixed when the draft is saved. Recipients, subject and body can be filled in later in the console. For a reply, pass `thread_id` to inherit the subject and send in that thread. For a forward, pass only `source_thread_id` to associate the draft with the original conversation and start a new thread on send.

`list_drafts` lists all drafts visible to the connection. Combine `inbox_id`, `pod_id`, `source_thread_id` and `query` to narrow the results. Use `limit` and `offset` to page through matches. The console also shows drafts in each inbox, in the main Drafts view, and on their source threads.

`create_draft` accepts `body` and `body_html`. OpenMail imports embedded and public HTTP(S) raster images into the draft. Attach files with `attachments: [{filename, content_type, content_base64}]`. For an uploaded image in the HTML, send `inline_images: [{content_id, content_type, content_base64}]` and reference its `inline-<UUID>@openmail` ID with `cid:` in the HTML. The MCP JSON request including base64 is limited to 4 MiB. For larger uploads, the public draft API accepts multipart files up to 25 MiB combined.

Read the saved draft with `get_draft` and its `draft_id`. Review the owning inbox, recipients, text and HTML, thread context, and any attachments before sending. On the user’s instruction, call `send_draft` with the ID and exact `updated_at` from that review. An optional `inbox_id` must match the owner. A successful send removes the draft. Changed versions require another review, and failed or pending attempts retain the draft. Read-only connections can list and read drafts. Creation and sending require write access and the OAuth `send` scope when using OAuth.

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
