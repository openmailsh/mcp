# OpenMail MCP

Hosted Streamable HTTP MCP at `https://mcp.openmail.sh/mcp`. Gmail for agents: one inbox, read human mail, reply in-thread.

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

`setup_agent_email` and `mint_inbox_key` return the new key in the tool result, so it lands in the agent's transcript. Move it to the agent's env and revoke it from the console if the transcript is shared.

**stdio-only clients:** `npx -y mcp-remote https://mcp.openmail.sh/mcp`

## Env

| Name | Purpose |
| --- | --- |
| `OPENMAIL_API_URL` | API origin (`https://api.openmail.sh`) |
| `MCP_RESOURCE_URL` | OAuth resource (`https://mcp.openmail.sh`) |
| `MCP_JWT_SECRET` | Same secret as the API. Required in production; outside production falls back to `NEXTAUTH_SECRET` |
| `CONSOLE_ORIGIN` | Consent page host |
| `PORT` | Listen port |

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
