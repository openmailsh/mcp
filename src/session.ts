export const TOOLSETS = ["docs", "mailbox", "domains"] as const;
export type Toolset = (typeof TOOLSETS)[number];

export type AuthKind = "none" | "api_key" | "oauth";

export type SessionContext = {
  readonly: boolean;
  inboxId: string | null;
  toolsets: Set<Toolset>;
  token: string | null;
  scopes: string[] | null;
  apiKeyInboxId: string | null;
  apiKeyPodId: string | null;
  authKind: AuthKind;
};

export const ALL_TOOLS = [
  "search_docs",
  "get_docs",
  "auth_me",
  "setup_agent_email",
  "send_mcp_feedback",
  "list_inboxes",
  "get_inbox",
  "create_inbox",
  "mint_inbox_key",
  "send_email",
  "reply_to_thread",
  "list_unread_threads",
  "read_thread",
  "mark_thread_read",
  "get_attachment_text",
  "list_domains",
  "get_domain",
  "add_domain",
  "verify_domain",
] as const;

export type ToolName = (typeof ALL_TOOLS)[number];

export function parseToolsets(raw: string | undefined): Set<Toolset> {
  if (!raw?.trim()) return new Set(TOOLSETS);
  const wanted = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is Toolset => (TOOLSETS as readonly string[]).includes(s)),
  );
  return wanted.size > 0 ? wanted : new Set(TOOLSETS);
}

export function parseSessionFromUrl(
  url: string,
  headers: { toolsets?: string },
): Pick<SessionContext, "readonly" | "inboxId" | "toolsets"> {
  const parsed = new URL(url, "http://local");
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const readonly =
    parsed.searchParams.get("readonly") === "true" ||
    path === "/readonly" ||
    path === "/mcp/readonly" ||
    path.endsWith("/readonly");
  const inboxMatch = path.match(/\/inbox\/([^/]+)$/);
  const toolsets = parseToolsets(
    parsed.searchParams.get("toolsets") ?? headers.toolsets,
  );
  return {
    readonly,
    inboxId: inboxMatch?.[1] ?? null,
    toolsets,
  };
}

function hasScope(ctx: SessionContext, scope: string): boolean {
  if (ctx.authKind === "api_key") {
    if (scope === "send") return true;
    if (scope === "setup" || scope === "domains") return ctx.apiKeyInboxId == null;
    return true;
  }
  return ctx.scopes?.includes(scope) ?? false;
}

export function visibleTools(ctx: SessionContext): ToolName[] {
  const tools: ToolName[] = [];
  if (ctx.toolsets.has("docs")) {
    tools.push("search_docs", "get_docs");
  }
  if (ctx.authKind === "none") return tools;

  tools.push("auth_me", "send_mcp_feedback");

  const inboxLocked = Boolean(ctx.inboxId || ctx.apiKeyInboxId);

  // Setup tools create inboxes / mint keys: writes that need the `setup`
  // scope and an account-wide view. setup_agent_email wraps both, so it
  // follows the same rule instead of appearing where it can only fail.
  const canSetup = !ctx.readonly && hasScope(ctx, "setup") && !ctx.apiKeyInboxId;
  if (canSetup && !inboxLocked) tools.push("setup_agent_email");
  if (canSetup && !ctx.inboxId) tools.push("create_inbox");
  if (canSetup) tools.push("mint_inbox_key");

  if (ctx.toolsets.has("mailbox")) {
    if (!inboxLocked) tools.push("list_inboxes");
    tools.push("get_inbox", "list_unread_threads", "read_thread", "get_attachment_text");
    // Marking read is a write (PATCH /v1/threads/:id); readonly sessions get none.
    if (!ctx.readonly) tools.push("mark_thread_read");
    if (!ctx.readonly && hasScope(ctx, "send")) {
      tools.push("send_email", "reply_to_thread");
    }
  }

  if (ctx.toolsets.has("domains") && !ctx.apiKeyInboxId) {
    tools.push("list_domains", "get_domain");
    if (!ctx.readonly && hasScope(ctx, "domains")) {
      tools.push("add_domain", "verify_domain");
    }
  }

  return tools;
}

export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith("om_");
}

/** URL lock or inbox-scoped API key — whichever pins this session. */
export function lockedInboxId(ctx: SessionContext): string | null {
  return ctx.inboxId || ctx.apiKeyInboxId || null;
}

export function assertLockedInbox(
  ctx: SessionContext,
  inboxId: string | null | undefined,
): void {
  const locked = lockedInboxId(ctx);
  if (!locked) return;
  if (inboxId !== locked) {
    throw new Error("This credential cannot access that inbox.");
  }
}
