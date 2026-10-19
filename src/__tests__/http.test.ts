import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../index";

describe("hosted MCP http", () => {
  it("serves health and install markdown", async () => {
    const app = createApp();
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");

    const install = await request(app).get("/");
    expect(install.status).toBe(200);
    expect(install.text).toContain("https://mcp.openmail.sh/mcp");

    // No token: the probe must be challenged so clients start OAuth.
    const probe = await request(app).get("/mcp");
    expect(probe.status).toBe(401);
    expect(probe.headers["www-authenticate"]).toContain("resource_metadata=");
    expect(probe.text).toContain("https://mcp.openmail.sh/mcp");

    // Signed in, asking for the server-push stream: stateless server, 405.
    const stream = await request(app)
      .get("/mcp")
      .set("Authorization", "Bearer om_whatever")
      .set("Accept", "text/event-stream");
    expect(stream.status).toBe(405);
    expect(stream.headers.allow).toBe("POST, DELETE");
    expect(stream.body.error.code).toBe(-32000);

    // Signed in, browser/curl: still the install text.
    const doc = await request(app)
      .get("/mcp")
      .set("Authorization", "Bearer om_whatever")
      .set("Accept", "*/*");
    expect(doc.status).toBe(200);
    expect(doc.type).toBe("text/markdown");

    // AS metadata is mirrored from the issuer for clients that skip RFC 9728.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.openmail.sh/.well-known/oauth-authorization-server") {
        return Response.json({ issuer: "https://api.openmail.sh", token_endpoint: "https://api.openmail.sh/oauth/token" });
      }
      return realFetch(input, init);
    });
    try {
      const as = await request(app).get("/.well-known/oauth-authorization-server");
      expect(as.status).toBe(200);
      expect(as.body.issuer).toBe("https://api.openmail.sh");
      expect(as.body.token_endpoint).toBe("https://api.openmail.sh/oauth/token");
    } finally {
      vi.unstubAllGlobals();
    }

    const meta = await request(app).get("/.well-known/oauth-protected-resource");
    expect(meta.status).toBe(200);
    expect(meta.body.resource).toBe("https://mcp.openmail.sh");
    expect(meta.body.authorization_servers).toEqual(
      expect.arrayContaining([expect.stringContaining("http")]),
    );
  });

  it("serves the OpenAI Apps domain challenge token", async () => {
    const res = await request(createApp()).get("/.well-known/openai-apps-challenge");
    expect(res.status).toBe(200);
    expect(res.text).toBe("TC5aZS0XkGJ9ecnhNE5mmzooru7PPsLPBnililVHOjE");
  });

  it("rate-limits anonymous /mcp calls per IP", async () => {
    const app = createApp();
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await request(app).get("/mcp")).status;
    expect(last).toBe(429);
  });

  it("canonicalizes MCP_RESOURCE_URL with a /mcp suffix", async () => {
    const previous = process.env.MCP_RESOURCE_URL;
    process.env.MCP_RESOURCE_URL = "https://mcp.openmail.sh/mcp/";
    try {
      const app = createApp();
      const meta = await request(app).get("/.well-known/oauth-protected-resource");
      expect(meta.body.resource).toBe("https://mcp.openmail.sh");
    } finally {
      if (previous === undefined) delete process.env.MCP_RESOURCE_URL;
      else process.env.MCP_RESOURCE_URL = previous;
    }
  });
});
