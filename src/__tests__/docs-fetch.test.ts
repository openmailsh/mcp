import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDocs, resetDocsCache, searchDocs } from "../docs";

const DOCS_FULL = "https://docs.openmail.sh/llms-full.txt";
const MARKETING = "https://openmail.sh/llms.txt";

const llmsFull = [
  "# Threading",
  "Source: https://docs.openmail.sh/concepts/threading",
  "",
  "## Reply to a thread",
  "POST /v1/inboxes/:id/send with threadId keeps the reply in the same thread.",
].join("\n");

const marketing = "# OpenMail\n\n## CLI Integration\nInstall the openmail CLI and paste your key.";

type Route = (url: string) => Response | Promise<Response>;

function routeFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return route(url);
  });
}

beforeEach(() => {
  resetDocsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("searchDocs corpus fetching", () => {
  it("searches both corpora and cites real page URLs", async () => {
    const fetchMock = routeFetch({
      [DOCS_FULL]: () => new Response(llmsFull),
      [MARKETING]: () => new Response(marketing),
    });
    vi.stubGlobal("fetch", fetchMock);

    const replies = await searchDocs("reply to a thread");
    expect(replies).toContain("Source: https://docs.openmail.sh/concepts/threading");
    expect(replies).not.toContain("llms-full.txt");

    const cli = await searchDocs("cli integration");
    expect(cli).toContain(`Source: ${MARKETING}`);
  });

  it("caches the corpus for 5 minutes", async () => {
    vi.useFakeTimers();
    const fetchMock = routeFetch({
      [DOCS_FULL]: () => new Response(llmsFull),
      [MARKETING]: () => new Response(marketing),
    });
    vi.stubGlobal("fetch", fetchMock);

    await searchDocs("reply");
    await searchDocs("reply again");
    expect(fetchMock).toHaveBeenCalledTimes(2); // one per source

    vi.advanceTimersByTime(4 * 60 * 1000);
    await searchDocs("still cached");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(2 * 60 * 1000); // past the 5-minute TTL
    await searchDocs("refetch");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("shares one fetch across concurrent calls (single-flight)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      await gate;
      return new Response(String(input) === DOCS_FULL ? llmsFull : marketing);
    });
    vi.stubGlobal("fetch", fetchMock);

    const calls = Promise.all([
      searchDocs("reply"),
      searchDocs("thread"),
      searchDocs("cli"),
    ]);
    release();
    const [a, b] = await calls;
    expect(fetchMock).toHaveBeenCalledTimes(2); // one per source, not per call
    expect(a).toContain("Source:");
    expect(b).toContain("Source:");
  });

  it("serves the stale corpus when a refresh fails", async () => {
    vi.useFakeTimers();
    let broken = false;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (broken) throw new Error("network down");
      return new Response(String(input) === DOCS_FULL ? llmsFull : marketing);
    });
    vi.stubGlobal("fetch", fetchMock);

    await searchDocs("reply"); // warm the cache
    broken = true;
    vi.advanceTimersByTime(6 * 60 * 1000);
    const out = await searchDocs("reply to a thread");
    expect(out).toContain("Source: https://docs.openmail.sh/concepts/threading");
  });

  it("returns an error message when the cache is cold and fetches fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    const out = await searchDocs("reply");
    expect(out).toContain("Could not fetch docs");
  });
});

describe("getDocs", () => {
  it("tries the .md variant of a docs page first", async () => {
    const fetchMock = routeFetch({
      "https://docs.openmail.sh/quickstart.md": () => new Response("# Quickstart (raw md)"),
      "https://docs.openmail.sh/quickstart": () => new Response("<html>rendered</html>"),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getDocs("https://docs.openmail.sh/quickstart")).toBe("# Quickstart (raw md)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the plain URL when the .md variant is missing", async () => {
    const fetchMock = routeFetch({
      "https://docs.openmail.sh/changelog": () => new Response("<html>changelog</html>"),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getDocs("https://docs.openmail.sh/changelog")).toBe("<html>changelog</html>");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not append .md to .txt or non-docs URLs", async () => {
    const fetchMock = routeFetch({
      "https://docs.openmail.sh/llms.txt": () => new Response("index"),
      "https://openmail.sh/pricing": () => new Response("pricing"),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getDocs("https://docs.openmail.sh/llms.txt")).toBe("index");
    expect(await getDocs("https://openmail.sh/pricing")).toBe("pricing");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still enforces the host allowlist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getDocs("https://evil.example/llms.txt")).toContain("are allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows redirects only to allowlisted hosts", async () => {
    const fetchMock = routeFetch({
      "https://docs.openmail.sh/old.md": () =>
        new Response(null, { status: 404 }),
      "https://docs.openmail.sh/old": () =>
        new Response(null, {
          status: 301,
          headers: { location: "https://evil.example/steal" },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await getDocs("https://docs.openmail.sh/old");
    expect(out).toContain("disallowed");
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://evil.example/steal",
      expect.anything(),
    );
  });

  it("follows redirects within the allowlist", async () => {
    const fetchMock = routeFetch({
      "https://docs.openmail.sh/moved.md": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://docs.openmail.sh/new-home.md" },
        }),
      "https://docs.openmail.sh/new-home.md": () => new Response("# New home"),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getDocs("https://docs.openmail.sh/moved")).toBe("# New home");
  });
});
