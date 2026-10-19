import { describe, expect, it, vi } from "vitest";
import {
  fetchAuthServerMetadata,
  AS_METADATA_TTL_MS,
  type AsMetadataCache,
} from "../as-metadata";

const META = { issuer: "https://api.openmail.sh", token_endpoint: "https://api.openmail.sh/oauth/token" };

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchAuthServerMetadata", () => {
  it("fetches the issuer's metadata verbatim and caches it", async () => {
    const fetcher = vi.fn(async () => ok(META));
    const cache: AsMetadataCache = { fetchedAt: 0 };
    let t = 1000;

    const first = await fetchAuthServerMetadata({ fetcher, cache, now: () => t });
    expect(first).toEqual(META);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "https://api.openmail.sh/.well-known/oauth-authorization-server",
    );

    t += AS_METADATA_TTL_MS - 1;
    await fetchAuthServerMetadata({ fetcher, cache, now: () => t });
    expect(fetcher).toHaveBeenCalledTimes(1);

    t += 2;
    await fetchAuthServerMetadata({ fetcher, cache, now: () => t });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent cold-cache fetches", async () => {
    const fetcher = vi.fn(async () => ok(META));
    const cache: AsMetadataCache = { fetchedAt: 0 };
    await Promise.all([
      fetchAuthServerMetadata({ fetcher, cache }),
      fetchAuthServerMetadata({ fetcher, cache }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves stale metadata when the refresh fails", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok(META))
      .mockResolvedValueOnce(new Response("down", { status: 503 }));
    const cache: AsMetadataCache = { fetchedAt: 0 };
    let t = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await fetchAuthServerMetadata({ fetcher, cache, now: () => t });
    t = AS_METADATA_TTL_MS + 1;
    const stale = await fetchAuthServerMetadata({ fetcher, cache, now: () => t });
    expect(stale).toEqual(META);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("throws on a cold cache when the issuer is unreachable", async () => {
    const fetcher = vi.fn(async () => new Response("down", { status: 503 }));
    const cache: AsMetadataCache = { fetchedAt: 0 };
    await expect(fetchAuthServerMetadata({ fetcher, cache })).rejects.toThrow(/HTTP 503/);
    expect(cache.inFlight).toBeUndefined();
  });
});
