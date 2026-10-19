import { mcpIssuer } from "./jwt.js";

/**
 * Authorization-server metadata (RFC 8414) mirrored from the issuer so that
 * clients which skip RFC 9728 discovery and fetch
 * `/.well-known/oauth-authorization-server` straight off the MCP host
 * (Composio does this) still find it. Spec-following clients never hit this:
 * they follow the 401 challenge to oauth-protected-resource and on to the
 * issuer.
 *
 * The body is served verbatim, `issuer` included, so it stays identical to
 * what the issuer publishes. AgentMail runs the same setup and Codex, ChatGPT,
 * Claude and Cursor all sign in against it.
 *
 * Cached with a single in-flight refresh and served stale when the API is
 * slow or down; only a cold cache surfaces an upstream failure.
 */

export const AS_METADATA_TTL_MS = 5 * 60 * 1000;
export const AS_METADATA_TIMEOUT_MS = 5000;

export type AsMetadataCache = {
  value?: Record<string, unknown>;
  fetchedAt: number;
  inFlight?: Promise<Record<string, unknown>>;
};

const defaultCache: AsMetadataCache = { fetchedAt: 0 };

export async function fetchAuthServerMetadata(
  deps: {
    fetcher?: typeof fetch;
    now?: () => number;
    cache?: AsMetadataCache;
    ttlMs?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const {
    fetcher = fetch,
    now = Date.now,
    cache = defaultCache,
    ttlMs = AS_METADATA_TTL_MS,
  } = deps;
  if (cache.value && now() - cache.fetchedAt < ttlMs) return cache.value;
  if (!cache.inFlight) {
    cache.inFlight = (async () => {
      const response = await fetcher(
        `${mcpIssuer()}/.well-known/oauth-authorization-server`,
        { signal: AbortSignal.timeout(AS_METADATA_TIMEOUT_MS) },
      );
      if (!response.ok) {
        throw new Error(
          `authorization-server metadata returned HTTP ${response.status}`,
        );
      }
      const value = (await response.json()) as Record<string, unknown>;
      cache.value = value;
      cache.fetchedAt = now();
      return value;
    })().finally(() => {
      cache.inFlight = undefined;
    });
  }
  try {
    return await cache.inFlight;
  } catch (error) {
    if (cache.value) {
      console.warn("[oauth] serving stale authorization-server metadata:", error);
      return cache.value;
    }
    throw error;
  }
}
