import { jwtVerify, type JWTPayload } from "jose";

/**
 * Same collapse rules as the API `canonicalMcpResource`. Keep this copy here
 * so the public MCP host does not import the private API package.
 */
export function canonicalMcpResource(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
  parsed.hash = "";
  parsed.search = "";
  const host = `${parsed.protocol}//${parsed.host}`;
  const path = parsed.pathname.replace(/\/+$/, "") || "";
  if (
    path === "" ||
    path === "/mcp" ||
    path === "/readonly" ||
    path.startsWith("/mcp/readonly") ||
    path.startsWith("/mcp/inbox/") ||
    path.startsWith("/inbox/")
  ) {
    return host;
  }
  return `${host}${path}`;
}

export function mcpResource(): string {
  const raw = process.env.MCP_RESOURCE_URL || "https://mcp.openmail.sh";
  return canonicalMcpResource(raw);
}

export function mcpIssuer(): string {
  return (process.env.OPENMAIL_API_URL || "https://api.openmail.sh").replace(
    /\/+$/,
    "",
  );
}

/**
 * HS256 key shared with the API. Production must set a dedicated
 * `MCP_JWT_SECRET`; the `NEXTAUTH_SECRET` fallback is for local setups only.
 */
export function jwtSecret(): Uint8Array {
  const dedicated = process.env.MCP_JWT_SECRET;
  if (dedicated) return new TextEncoder().encode(dedicated);
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "MCP_JWT_SECRET is required in production; refusing to fall back to NEXTAUTH_SECRET.",
    );
  }
  const fallback = process.env.NEXTAUTH_SECRET;
  if (!fallback) {
    throw new Error("MCP_JWT_SECRET or NEXTAUTH_SECRET is required");
  }
  return new TextEncoder().encode(fallback);
}

export async function verifyMcpAccessToken(
  token: string,
): Promise<(JWTPayload & { grant_id: string; scope: string }) | null> {
  // Resolved outside the try so a missing secret is a loud config error, not a 401.
  const secret = jwtSecret();
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: mcpIssuer(),
      audience: mcpResource(),
    });
    if (payload.token_use !== "mcp_at") return null;
    if (typeof payload.grant_id !== "string") return null;
    if (typeof payload.scope !== "string") return null;
    return payload as JWTPayload & { grant_id: string; scope: string };
  } catch {
    return null;
  }
}
