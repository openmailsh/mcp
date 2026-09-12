const MARKETING_LLMS_URL = process.env.DOCS_URL || "https://openmail.sh/llms.txt";
const DOCS_LLMS_FULL_URL =
  process.env.DOCS_FULL_URL || "https://docs.openmail.sh/llms-full.txt";

const ALLOWED_HOSTS = new Set([
  "openmail.sh",
  "www.openmail.sh",
  "docs.openmail.sh",
]);

export type DocChunk = {
  title: string;
  url: string;
  text: string;
};

export function chunkMarkdown(markdown: string, sourceUrl: string): DocChunk[] {
  const parts = markdown.split(/\n(?=## )/);
  return parts
    .map((part) => {
      const line = part.trim();
      if (!line) return null;
      const heading = line.match(/^##?\s+(.+)$/m)?.[1]?.trim() || "OpenMail";
      return { title: heading, url: sourceUrl, text: line.trim() };
    })
    .filter((c): c is DocChunk => c !== null);
}

/**
 * Parse a Mintlify llms-full.txt: pages are delimited by a `# Title` line
 * immediately followed by `Source: <url>`. Content lines may also start with
 * `# ` (shell comments in code blocks), so the `Source:` line is what marks a
 * real page boundary. Each page is then chunked by `## ` section, and every
 * chunk carries the page's real URL so citations point at the live docs page.
 */
export function chunkLlmsFull(text: string): DocChunk[] {
  const pages = text.split(/\n(?=# [^\n]*\nSource: https?:\/\/)/);
  const chunks: DocChunk[] = [];
  for (const page of pages) {
    const header = page.match(/^# ([^\n]*)\nSource: (\S+)/);
    if (!header) continue;
    const pageTitle = header[1].trim() || "OpenMail";
    const pageUrl = header[2];
    const body = page.slice(header[0].length);
    for (const part of body.split(/\n(?=## )/)) {
      const section = part.trim();
      if (!section) continue;
      const heading = section.match(/^##\s+(.+)$/m)?.[1]?.trim();
      chunks.push({
        title: heading ? `${pageTitle} — ${heading}` : pageTitle,
        url: pageUrl,
        text: section,
      });
    }
  }
  return chunks;
}

const STOP_WORDS = new Set(["a", "an", "the", "to", "of", "in", "on", "how", "do", "i"]);

/** Occurrences of `needle` in `hay`, capped so a wall of text cannot win on repetition alone. */
function countCapped(hay: string, needle: string, cap: number): number {
  let count = 0;
  let from = 0;
  while (count < cap) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

export function rankChunks(chunks: DocChunk[], query: string, limit = 5): DocChunk[] {
  const phrase = normalizeQuery(query);
  const terms = [...new Set(phrase.split(" ").filter((t) => t.length > 1 && !STOP_WORDS.has(t)))];
  if (terms.length === 0 && !phrase) return [];

  const scored = chunks.map((chunk) => {
    const title = chunk.title.toLowerCase();
    const body = chunk.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      // Body: term frequency, capped per chunk. Title: a flat ×3 bonus.
      score += term.length * countCapped(body, term, 5);
      if (title.includes(term)) score += term.length * 3;
    }
    // Exact phrase beats any combination of scattered terms.
    if (phrase.includes(" ")) {
      if (title.includes(phrase)) score += phrase.length * 6;
      else if (body.includes(phrase)) score += phrase.length * 3;
    }
    // Slight preference for focused sections over sprawling pages.
    const lengthPenalty = Math.log(Math.max(chunk.text.length, 100));
    return { chunk, score: score / lengthPenalty };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.chunk);
}

export function formatSearchResults(chunks: DocChunk[]): string {
  if (chunks.length === 0) {
    return "No matching docs. Try get_docs with https://docs.openmail.sh/quickstart";
  }
  return chunks
    .map((chunk) => {
      const excerpt = chunk.text.length > 800 ? `${chunk.text.slice(0, 800)}…` : chunk.text;
      return `## ${chunk.title}\nSource: ${chunk.url}\n\n${excerpt}`;
    })
    .join("\n\n");
}

export function isAllowedDocsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      ALLOWED_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Fetch with manual redirect handling: redirects are only followed when the
 * target passes the same host allowlist, so an allowed URL cannot bounce the
 * client to an arbitrary origin. Capped at 3 hops.
 */
async function fetchAllowed(url: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(current, {
      headers: { "User-Agent": "openmail-mcp" },
      redirect: "manual",
    });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    const next = new URL(location, current).toString();
    if (!isAllowedDocsUrl(next)) {
      throw new Error(`Redirect to disallowed URL: ${next}`);
    }
    current = next;
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

// --- Corpus cache: in-memory, 5-minute TTL, single-flight. -----------------

const CORPUS_TTL_MS = 5 * 60 * 1000;

let corpusCache: { chunks: DocChunk[]; fetchedAt: number } | null = null;
let corpusInFlight: Promise<DocChunk[]> | null = null;

/** Test hook: clear the corpus cache and any in-flight fetch. */
export function resetDocsCache(): void {
  corpusCache = null;
  corpusInFlight = null;
}

async function fetchSource(
  url: string,
  parse: (text: string) => DocChunk[],
): Promise<DocChunk[] | null> {
  try {
    const res = await fetchAllowed(url);
    if (!res.ok) return null;
    return parse(await res.text());
  } catch {
    return null;
  }
}

/**
 * Build the search corpus: the docs site's llms-full.txt (one chunk per `## `
 * section of each page, cited with the page's real URL) plus the marketing
 * llms.txt, which still carries integration/CLI content the docs lack. Both
 * rank through the same scorer — no source is boosted.
 */
async function fetchCorpus(): Promise<DocChunk[]> {
  const [docs, marketing] = await Promise.all([
    fetchSource(DOCS_LLMS_FULL_URL, chunkLlmsFull),
    fetchSource(MARKETING_LLMS_URL, (text) => chunkMarkdown(text, MARKETING_LLMS_URL)),
  ]);
  if (!docs && !marketing) {
    throw new Error(`Could not fetch docs. See ${DOCS_LLMS_FULL_URL}`);
  }
  return [...(docs ?? []), ...(marketing ?? [])];
}

async function loadCorpus(): Promise<DocChunk[]> {
  if (corpusCache && Date.now() - corpusCache.fetchedAt < CORPUS_TTL_MS) {
    return corpusCache.chunks;
  }
  if (corpusInFlight) return corpusInFlight;
  corpusInFlight = fetchCorpus()
    .then((chunks) => {
      corpusCache = { chunks, fetchedAt: Date.now() };
      return chunks;
    })
    .catch((err) => {
      // Serve the stale corpus when a refresh fails; error only on cold cache.
      if (corpusCache) return corpusCache.chunks;
      throw err;
    })
    .finally(() => {
      corpusInFlight = null;
    });
  return corpusInFlight;
}

export async function searchDocs(query: string): Promise<string> {
  let corpus: DocChunk[];
  try {
    corpus = await loadCorpus();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return formatSearchResults(rankChunks(corpus, query));
}

/**
 * True when appending `.md` to this docs.openmail.sh URL may yield the raw
 * markdown Mintlify serves alongside each page.
 */
function markdownVariant(target: string): string | null {
  try {
    const url = new URL(target);
    if (url.hostname !== "docs.openmail.sh") return null;
    const path = url.pathname;
    if (path === "/" || path.endsWith("/") || /\.(md|txt)$/.test(path)) return null;
    url.pathname = `${path}.md`;
    return url.toString();
  } catch {
    return null;
  }
}

export async function getDocs(url: string): Promise<string> {
  const target = url.trim() || MARKETING_LLMS_URL;
  if (!isAllowedDocsUrl(target)) {
    return "Only openmail.sh and docs.openmail.sh URLs are allowed.";
  }
  let res: Response;
  try {
    // Docs pages also exist as raw markdown at <url>.md — much better for an
    // agent than the rendered HTML, so try that first and fall back.
    const mdUrl = markdownVariant(target);
    if (mdUrl) {
      const mdRes = await fetchAllowed(mdUrl);
      res = mdRes.ok ? mdRes : await fetchAllowed(target);
    } else {
      res = await fetchAllowed(target);
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (!res.ok) return `Could not fetch ${target} (${res.status}).`;
  const text = await res.text();
  return text.length > 20000 ? `${text.slice(0, 20000)}\n\n…truncated` : text;
}
