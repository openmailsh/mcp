import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { createOpenMailApi, type MeResponse } from "./openmail.js";
import { INSTALL_MARKDOWN } from "./format.js";
import { verifyMcpAccessToken, mcpIssuer, mcpResource } from "./jwt.js";
import {
  looksLikeApiKey,
  looksLikeJwt,
  parseSessionFromUrl,
  type SessionContext,
} from "./session.js";

const API_URL = (process.env.OPENMAIL_API_URL || "https://api.openmail.sh").replace(
  /\/+$/,
  "",
);

function cors(res: express.Response) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Session-Id, MCP-Protocol-Version, X-MCP-Toolsets");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Link",
    `</.well-known/oauth-protected-resource>; rel="https://datatracker.ietf.org/doc/html/rfc9728"`,
  );
}

function resourceMetadata() {
  const resource = mcpResource();
  return {
    resource,
    authorization_servers: [mcpIssuer()],
    bearer_tokens_supported: true,
    scopes_supported: ["read", "setup", "send", "domains"],
    resource_documentation: "https://docs.openmail.sh",
  };
}

function wwwAuthenticate(): string {
  return `Bearer realm="OpenMail MCP", resource_metadata="${mcpResource()}/.well-known/oauth-protected-resource"`;
}

function bearerToken(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7).trim() || null;
  }
  return null;
}

async function resolveAuth(token: string | null): Promise<{
  ctxAuth: Pick<SessionContext, "token" | "scopes" | "apiKeyInboxId" | "apiKeyPodId" | "authKind">;
  me: MeResponse | null;
  unauthorized: boolean;
}> {
  if (!token) {
    return {
      ctxAuth: {
        token: null,
        scopes: null,
        apiKeyInboxId: null,
        apiKeyPodId: null,
        authKind: "none",
      },
      me: null,
      unauthorized: false,
    };
  }

  if (looksLikeJwt(token)) {
    const payload = await verifyMcpAccessToken(token);
    if (!payload) {
      return {
        ctxAuth: {
          token: null,
          scopes: null,
          apiKeyInboxId: null,
          apiKeyPodId: null,
          authKind: "none",
        },
        me: null,
        unauthorized: true,
      };
    }
    const me = (await createOpenMailApi(API_URL, token).get("/v1/me").catch(
      () => null,
    )) as MeResponse | null;
    return {
      ctxAuth: {
        token,
        scopes: payload.scope.split(/\s+/),
        apiKeyInboxId: null,
        apiKeyPodId: null,
        authKind: "oauth",
      },
      me,
      unauthorized: false,
    };
  }

  if (!looksLikeApiKey(token)) {
    return {
      ctxAuth: {
        token: null,
        scopes: null,
        apiKeyInboxId: null,
        apiKeyPodId: null,
        authKind: "none",
      },
      me: null,
      unauthorized: true,
    };
  }

  try {
    const me = (await createOpenMailApi(API_URL, token).get("/v1/me")) as MeResponse;
    const scoped = me.apiKeyScope !== "account" ? me.apiKeyScope : null;
    return {
      ctxAuth: {
        token,
        scopes: null,
        apiKeyInboxId: scoped?.inboxId ?? null,
        apiKeyPodId: scoped?.podId ?? null,
        authKind: "api_key",
      },
      me,
      unauthorized: false,
    };
  } catch {
    return {
      ctxAuth: {
        token: null,
        scopes: null,
        apiKeyInboxId: null,
        apiKeyPodId: null,
        authKind: "none",
      },
      me: null,
      unauthorized: true,
    };
  }
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use((req, res, next) => {
    cors(res);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const wellKnown: express.RequestHandler = (_req, res) => {
    res.json(resourceMetadata());
  };
  app.get(
    /^\/\.well-known\/oauth-protected-resource(\/.*)?$/,
    wellKnown,
  );
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    const issuer = mcpIssuer();
    res.json({
      issuer,
      authorization_endpoint: `${(process.env.CONSOLE_ORIGIN || "https://console.openmail.sh").replace(/\/+$/, "")}/mcp/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      scopes_supported: ["read", "setup", "send", "domains"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  app.get(["/", "/mcp"], (_req, res) => {
    res.type("text/markdown").send(INSTALL_MARKDOWN);
  });

  const handleMcp: express.RequestHandler = async (req, res) => {
    const token = bearerToken(req);
    const auth = await resolveAuth(token);
    if (auth.unauthorized) {
      res.setHeader("WWW-Authenticate", wwwAuthenticate());
      res.status(401).json({
        error: "invalid_token",
        error_description: "Invalid or missing OpenMail credential",
      });
      return;
    }

    const parsed = parseSessionFromUrl(req.originalUrl, {
      toolsets:
        typeof req.headers["x-mcp-toolsets"] === "string"
          ? req.headers["x-mcp-toolsets"]
          : undefined,
    });
    const ctx: SessionContext = {
      ...parsed,
      ...auth.ctxAuth,
    };
    const api = ctx.token ? createOpenMailApi(API_URL, ctx.token) : null;
    const server = createMcpServer({ ctx, api, me: auth.me });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: false,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  for (const path of [
    "/",
    "/mcp",
    "/mcp/readonly",
    "/readonly",
    "/mcp/inbox/:inboxId",
    "/inbox/:inboxId",
  ]) {
    app.post(path, handleMcp);
    app.delete(path, handleMcp);
  }

  return app;
}
