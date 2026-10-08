# OpenMail MCP

Hosted Streamable HTTP MCP at `https://mcp.openmail.sh/mcp`. Gmail for agents: one inbox, read mail that wants a reply, reply in-thread.

There is **no local stdio catalog** — stdio-only clients should use `mcp-remote`.

## Connect

**Claude (OAuth):** paste `https://mcp.openmail.sh/mcp`

**Cursor (OAuth):** [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=openmail&config=eyJ1cmwiOiJodHRwczovL21jcC5vcGVubWFpbC5zaC9tY3AifQ==), or add the URL below without `headers`. Also on [cursor.directory](https://cursor.directory/plugins/openmail) as a plugin (`.cursor-plugin/plugin.json` + `mcp.json`).

**Claude Code:** `claude mcp add --transport http openmail https://mcp.openmail.sh/mcp`, or install as a plugin (`claude plugin marketplace add openmailsh/mcp`, then `claude plugin install openmail@openmailsh-mcp`): the plugin bundles the server with the `openmail` skill in `skills/`, which teaches the agent when to reach for email and how to handle a thread.

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
