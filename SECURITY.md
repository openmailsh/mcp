# Security

The hosted server at `mcp.openmail.sh` handles OAuth tokens, API keys, and mail
on behalf of OpenMail customers. If you find a vulnerability in this code or in
the hosted service, tell us privately first.

## Reporting

Email **support@openmail.sh** with:

- What you found and where (file, endpoint, or tool)
- Steps to reproduce
- Impact as you understand it

You will hear back within 3 business days. Please give us a reasonable window
to fix the issue before you publish anything.

Do not open a public issue for security problems.

## Out of scope

- Rate limiting and denial of service against the hosted service
- Reports from automated scanners without a working proof of concept
- Issues in third-party MCP clients (Claude, ChatGPT, Cursor) rather than this
  server
