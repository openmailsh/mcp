import { afterEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  canonicalMcpResource,
  jwtSecret,
  mcpResource,
  verifyMcpAccessToken,
} from "../jwt";

describe("canonicalMcpResource", () => {
  it("collapses /mcp and inbox-lock paths onto the origin", () => {
    expect(canonicalMcpResource("https://mcp.openmail.sh/")).toBe(
      "https://mcp.openmail.sh",
    );
    expect(canonicalMcpResource("https://mcp.openmail.sh/mcp")).toBe(
      "https://mcp.openmail.sh",
    );
    expect(canonicalMcpResource("https://mcp.openmail.sh/mcp/readonly")).toBe(
      "https://mcp.openmail.sh",
    );
    expect(canonicalMcpResource("https://mcp.openmail.sh/mcp/inbox/abc")).toBe(
      "https://mcp.openmail.sh",
    );
  });

  it("does not collapse unrelated paths", () => {
    expect(canonicalMcpResource("https://mcp.openmail.sh/other")).toBe(
      "https://mcp.openmail.sh/other",
    );
  });
});

describe("mcpResource", () => {
  afterEach(() => {
    delete process.env.MCP_RESOURCE_URL;
  });

  it("canonicalizes a /mcp suffix in env", () => {
    process.env.MCP_RESOURCE_URL = "https://mcp.openmail.sh/mcp/";
    expect(mcpResource()).toBe("https://mcp.openmail.sh");
  });
});

describe("verifyMcpAccessToken", () => {
  const secret = "test-secret-at-least-32-chars-long!!";

  afterEach(() => {
    delete process.env.MCP_RESOURCE_URL;
    delete process.env.MCP_JWT_SECRET;
    delete process.env.OPENMAIL_API_URL;
  });

  it("accepts tokens the API signed for the canonical origin", async () => {
    process.env.MCP_JWT_SECRET = secret;
    process.env.OPENMAIL_API_URL = "https://api.openmail.sh";
    process.env.MCP_RESOURCE_URL = "https://mcp.openmail.sh/mcp";
    const token = await new SignJWT({
      token_use: "mcp_at",
      grant_id: "grant-1",
      scope: "read setup",
    })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer("https://api.openmail.sh")
      .setAudience("https://mcp.openmail.sh")
      .setSubject("cust-1")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));

    const payload = await verifyMcpAccessToken(token);
    expect(payload?.grant_id).toBe("grant-1");
  });
});

describe("jwtSecret", () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    MCP_JWT_SECRET: process.env.MCP_JWT_SECRET,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("falls back to NEXTAUTH_SECRET outside production", () => {
    process.env.NODE_ENV = "test";
    delete process.env.MCP_JWT_SECRET;
    process.env.NEXTAUTH_SECRET = "console";
    expect(new TextDecoder().decode(jwtSecret())).toBe("console");
  });

  it("refuses the fallback in production and surfaces it from verify", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.MCP_JWT_SECRET;
    process.env.NEXTAUTH_SECRET = "console";
    expect(() => jwtSecret()).toThrow(/MCP_JWT_SECRET is required in production/);
    await expect(verifyMcpAccessToken("a.b.c")).rejects.toThrow(/MCP_JWT_SECRET/);
  });

  it("uses the dedicated secret in production when set", () => {
    process.env.NODE_ENV = "production";
    process.env.MCP_JWT_SECRET = "dedicated";
    expect(new TextDecoder().decode(jwtSecret())).toBe("dedicated");
  });
});
