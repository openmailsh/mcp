const DOCS_URL = process.env.DOCS_URL || "https://openmail.sh/llms.txt";

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

export function rankChunks(chunks: DocChunk[], query: string, limit = 5): DocChunk[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const scored = chunks.map((chunk) => {
    const hay = `${chunk.title}\n${chunk.text}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (hay.includes(term)) score += term.length;
    }
    return { chunk, score };
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

export async function searchDocs(query: string): Promise<string> {
  const res = await fetch(DOCS_URL, {
    headers: { "User-Agent": "openmail-mcp" },
  });
  if (!res.ok) {
    return `Could not fetch docs (${res.status}). See ${DOCS_URL}`;
  }
  const markdown = await res.text();
  const ranked = rankChunks(chunkMarkdown(markdown, DOCS_URL), query);
  return formatSearchResults(ranked);
}

export async function getDocs(url: string): Promise<string> {
  const target = url.trim() || DOCS_URL;
  if (!isAllowedDocsUrl(target)) {
    return "Only openmail.sh and docs.openmail.sh URLs are allowed.";
  }
  const res = await fetch(target, {
    headers: { "User-Agent": "openmail-mcp" },
  });
  if (!res.ok) return `Could not fetch ${target} (${res.status}).`;
  const text = await res.text();
  return text.length > 20000 ? `${text.slice(0, 20000)}\n\n…truncated` : text;
}
