import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../index";

describe("hosted MCP http", () => {
  it("serves health and install markdown", async () => {
    const app = createApp();
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");

    const install = await request(app).get("/mcp");
    expect(install.status).toBe(200);
    expect(install.text).toContain("https://mcp.openmail.sh/mcp");

    const meta = await request(app).get("/.well-known/oauth-protected-resource");
    expect(meta.status).toBe(200);
    expect(meta.body.resource).toBe("https://mcp.openmail.sh");
    expect(meta.body.authorization_servers).toEqual(
      expect.arrayContaining([expect.stringContaining("http")]),
    );
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
