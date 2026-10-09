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

  it("serves the domain-verification token as plain text only when configured", async () => {
    const off = await request(createApp()).get("/.well-known/openai-challenge");
    expect(off.status).toBe(404);

    process.env.DOMAIN_CHALLENGE_PATH = "/.well-known/openai-challenge";
    process.env.DOMAIN_CHALLENGE_TOKEN = "tok-123";
    try {
      const on = await request(createApp()).get("/.well-known/openai-challenge");
      expect(on.status).toBe(200);
      expect(on.headers["content-type"]).toMatch(/^text\/plain/);
      expect(on.text).toBe("tok-123");
    } finally {
      delete process.env.DOMAIN_CHALLENGE_PATH;
      delete process.env.DOMAIN_CHALLENGE_TOKEN;
    }
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
