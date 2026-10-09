import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { instrumentServer } from "./analytics.js";
import { ApiError, createOpenMailApi, type MeResponse } from "./openmail.js";
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

/** Anonymous, docs-only endpoint. Everything else requires a credential. */
function isPublicPath(path: string): boolean {
  const p = path.replace(/\/+$/, "");
  return p === "/public" || p === "/mcp/public";
}

function bearerToken(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7).trim() || null;
  }
  return null;
}

type ResolvedAuth = {
  ctxAuth: Pick<SessionContext, "token" | "scopes" | "apiKeyInboxId" | "apiKeyPodId" | "authKind">;
  me: MeResponse | null;
  /** Credential is missing, malformed, revoked, or rejected by the API (401/403). */
  unauthorized: boolean;
  /** The API could not tell us who the credential is (5xx / network). */
  upstreamUnavailable: boolean;
};

const NO_AUTH: ResolvedAuth["ctxAuth"] = {
  token: null,
  scopes: null,
  apiKeyInboxId: null,
  apiKeyPodId: null,
  authKind: "none",
};

function anonymous(): ResolvedAuth {
  return { ctxAuth: NO_AUTH, me: null, unauthorized: false, upstreamUnavailable: false };
}

function rejected(): ResolvedAuth {
  return { ctxAuth: NO_AUTH, me: null, unauthorized: true, upstreamUnavailable: false };
}

function unavailable(): ResolvedAuth {
  return { ctxAuth: NO_AUTH, me: null, unauthorized: false, upstreamUnavailable: true };
}

/** The API said this credential is not (or no longer) valid. */
function isCredentialRejection(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

function warnMeFailure(kind: string, err: unknown): void {
  const status = err instanceof ApiError ? err.status : "network";
  // Never log the token itself.
  console.warn(`[mcp] GET /v1/me failed for ${kind} credential (${status})`);
}

async function resolveAuth(token: string | null): Promise<ResolvedAuth> {
  if (!token) return anonymous();

  if (looksLikeJwt(token)) {
    const payload = await verifyMcpAccessToken(token);
    if (!payload) return rejected();

    // A signature that verifies only proves we minted the token; the grant
    // behind it may since have been revoked. The API is the source of truth.
    let me: MeResponse | null = null;
    try {
      me = (await createOpenMailApi(API_URL, token).get("/v1/me")) as MeResponse;
    } catch (err) {
      if (isCredentialRejection(err)) return rejected();
      // 5xx / network: keep serving with the scopes from the token so a
      // blip at the API does not force every client back through OAuth.
      warnMeFailure("oauth", err);
    }
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
      upstreamUnavailable: false,
    };
  }

  if (!looksLikeApiKey(token)) return rejected();

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
      upstreamUnavailable: false,
    };
  } catch (err) {
    if (isCredentialRejection(err)) return rejected();
    // An API key's scope comes only from /v1/me, so without it we cannot
    // safely serve anything — but that is our outage, not a bad credential.
    warnMeFailure("api_key", err);
    return unavailable();
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

  // Directory domain verification (OpenAI Apps). The portal names a path on this
  // host and a token; serve the token as plain text there. Both come from env so
  // the next challenge is a redeploy, not a release. Off when either is unset.
  const challengePath = process.env.DOMAIN_CHALLENGE_PATH?.trim();
  const challengeToken = process.env.DOMAIN_CHALLENGE_TOKEN?.trim();
  if (challengePath && challengeToken && challengePath.startsWith("/")) {
    app.get(challengePath, (_req, res) => {
      res.type("text/plain").send(challengeToken);
    });
  }

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
    // Clients only start OAuth when they see a 401 with WWW-Authenticate. A
    // 200 with docs-only tools looks like a working server with two tools, so
    // the user is never asked to sign in. Anonymous docs stay available at
    // the explicit /public paths for agents that want them.
    if (!token && !isPublicPath(req.path)) {
      res.setHeader("WWW-Authenticate", wwwAuthenticate());
      res.status(401).json({
        error: "unauthorized",
        error_description: "Sign in to OpenMail to use this MCP server. Docs-only access: /mcp/public",
      });
      return;
    }
    const auth = await resolveAuth(token);
    if (auth.unauthorized) {
      res.setHeader("WWW-Authenticate", wwwAuthenticate());
      res.status(401).json({
        error: "invalid_token",
        error_description: "Invalid or missing OpenMail credential",
      });
      return;
    }
    if (auth.upstreamUnavailable) {
      // Not a 401: that would make clients discard a perfectly good key.
      res.status(503).json({
        error: "upstream_unavailable",
        error_description: "OpenMail API is unavailable; retry shortly",
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
    instrumentServer(server, { ctx, me: auth.me });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: false,
      // Stateless: a fresh server per request. JSON (not SSE) responses let
      // the analytics SDK put client name/version in Mcp-Session-Id so later
      // requests on other pods still know who is calling.
      enableJsonResponse: true,
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
    "/mcp/public",
    "/public",
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
