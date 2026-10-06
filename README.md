# OpenMail MCP

Hosted Streamable HTTP MCP at `https://mcp.openmail.sh/mcp`. Gmail for agents: one inbox, read mail that wants a reply, reply in-thread.

There is **no local stdio catalog** — stdio-only clients should use `mcp-remote`.

## Connect

**Claude (OAuth):** paste `https://mcp.openmail.sh/mcp`

**Cursor (API key):**

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
