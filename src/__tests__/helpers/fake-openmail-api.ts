/**
 * In-process stand-in for api.openmail.sh — the one true network boundary of
 * the MCP host. Plain `node:http`, no framework: it serves the handful of /v1
 * routes the tools call, authenticates by looking the bearer token up in
 * `state.tokens`, mutates `state` the way the real API would, and records
 * every request so tests can assert on what crossed the wire.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Draft } from "../../format.js";
import type { MeResponse } from "../../openmail.js";

export type FakeMessage = {
  id: string;
  direction: "inbound" | "outbound";
  fromAddr: string;
  toAddr?: string;
  createdAt?: string;
  bodyText?: string | null;
  autoReplyable?: boolean | null;
  attachments?: Array<{ filename: string }>;
};

export type FakeThread = {
  id: string;
  inboxId: string;
  subject: string | null;
  isRead: boolean;
  lastMessageAt: string;
  messages: FakeMessage[];
  trashed?: boolean;
};

export type FakeInbox = {
  id: string;
  podId?: string | null;
  address: string;
  displayName?: string | null;
  forwardTo?: string | null;
  forwardWhen?: string | null;
  forwardStatus?: string | null;
};

export type FakeAttachment = {
  inboxId: string;
  text: string;
  /** Raw file. Omitted → the extracted text, as UTF-8. */
  bytes?: Buffer;
  contentType?: string;
  /** Overrides Content-Length. Used to refuse a download before the body is read. */
  contentLength?: number;
  /** Two writes and no Content-Length, so the client has to count bytes. */
  omitContentLength?: boolean;
};

export type FakeState = {
  /** bearer token → who it is. Anything else is 401. */
  tokens: Record<string, MeResponse>;
  inboxes: FakeInbox[];
  threads: Record<string, FakeThread>;
  attachments: Record<string, FakeAttachment>;
  drafts?: Draft[];
  draftSendFailure?: { status: number; body: { error: string; message: string } };
  /** When set, GET /v1/me answers with this instead of looking the token up (simulates an API outage). */
  meFailure?: { status: number; body?: unknown };
  /** Custom domains. A domain with a podId only accepts inboxes created with that podId. */
  domains?: FakeDomain[];
  /** When set, POST /v1/inboxes/{id}/send answers with this (cap hit, suspension). */
  sendFailure?: { status: number; body: unknown };
};

export type FakeDomain = { id: string; domain: string; status: string; podId: string | null };

export type RecordedRequest = {
  method: string;
  path: string;
  token: string | null;
  headers: http.IncomingHttpHeaders;
  body: unknown;
};

export type FakeOpenMailApi = {
  url: string;
  state: FakeState;
  requests: RecordedRequest[];
  /** Requests matching a method + path regex. */
  calls(method: string, path: RegExp): RecordedRequest[];
  reset(state: FakeState): void;
  close(): Promise<void>;
};

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const data = Buffer.concat(chunks);
  if (!data.length) return undefined;
  const contentType = req.headers["content-type"] ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    return new Response(data, { headers: { "Content-Type": contentType } }).formData();
  }
  const raw = data.toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function emptyState(): FakeState {
  return { tokens: {}, inboxes: [], threads: {}, attachments: {} };
}

export async function startFakeOpenMailApi(initial: FakeState = emptyState()): Promise<FakeOpenMailApi> {
  let state = initial;
  const requests: RecordedRequest[] = [];
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const body = await readBody(req);
    requests.push({ method, path: url.pathname + url.search, token, headers: req.headers, body });
    // Mirror the real API: a JSON content type with no body is rejected.
    if (body === undefined && String(req.headers["content-type"] ?? "").includes("application/json")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "empty_body", message: "Request body is required" }));
      return;
    }

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (method === "GET" && path === "/v1/me" && state.meFailure) {
      return json(state.meFailure.status, state.meFailure.body ?? { error: "internal", message: "boom" });
    }

    const me = token ? state.tokens[token] : undefined;
    if (!me) {
      return json(401, { error: "unauthorized", message: "Invalid API key" });
    }

    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/v1/me") return json(200, me);

    if (method === "GET" && path === "/v1/inboxes") return json(200, { data: state.inboxes });

    const draftScope = me.apiKeyScope === "account" ? null : me.apiKeyScope;
    const visibleDraft = (draft: Draft) => !draftScope || (!!draft.inboxId &&
      (!draftScope.inboxId || draft.inboxId === draftScope.inboxId) &&
      (!draftScope.podId || state.inboxes.find((i) => i.id === draft.inboxId)?.podId === draftScope.podId));
    if (method === "POST" && (m = path.match(/^\/v1\/drafts\/([^/]+)\/send$/))) {
      const draftId = decodeURIComponent(m[1]);
      const draft = state.drafts?.find((row) => row.id === draftId);
      if (!draft) return json(404, { error: "not_found", message: "Draft not found" });
      if (!visibleDraft(draft)) return json(403, { error: "forbidden" });
      const input = body as { updatedAt?: string; inboxId?: string };
      if (input.updatedAt !== draft.updatedAt) return json(409, { error: "draft_changed", message: "This draft changed. Refresh before continuing." });
      if (input.inboxId && input.inboxId !== draft.inboxId) return json(400, { error: "draft_inbox_locked", message: "A draft must use its original sending inbox." });
      if (!draft.to || !draft.subject || (!draft.bodyText && !draft.bodyHtml)) return json(400, { error: "incomplete_draft", message: "Complete the draft before sending." });
      if (state.draftSendFailure) {
        if (state.draftSendFailure.body.error === "send_failed") draft.updatedAt = new Date(Math.max(Date.now(), Date.parse(draft.updatedAt) + 1)).toISOString();
        return json(state.draftSendFailure.status, state.draftSendFailure.body);
      }
      state.drafts = state.drafts!.filter((row) => row.id !== draftId);
      return json(200, { messageId: `msg-${++seq}`, threadId: draft.threadId ?? `thread-${seq}`, status: "sent" });
    }
    if ((m = path.match(/^\/v1\/drafts(?:\/([^/]+))?$/))) {
      const draftId = m[1] ? decodeURIComponent(m[1]) : undefined;
      const drafts = state.drafts ??= [];
      if (method === "POST" && !draftId) {
        const payload = body instanceof FormData ? {
          ...Object.fromEntries(body),
          cc: body.getAll("cc"), bcc: body.getAll("bcc"),
        } : body;
        const b = payload as { inboxId?: string; threadId?: string; sourceThreadId?: string; to?: string; cc?: string[]; bcc?: string[]; subject?: string; body?: string; bodyHtml?: string };
        if (!b.inboxId) return json(400, { error: "inbox_required" });
        if (!state.inboxes.some(i => i.id === b.inboxId)) return json(404, { error: "not_found" });
        const sourceId = b.sourceThreadId ?? b.threadId;
        if (b.threadId && b.threadId !== sourceId) return json(400, { error: "invalid_draft" });
        const source = sourceId ? state.threads[sourceId] : undefined;
        if (sourceId && source?.inboxId !== b.inboxId) return json(404, { error: "not_found" });
        const attachments: NonNullable<Draft["attachments"]> = [];
        if (body instanceof FormData) {
          for (const key of ["attachments", "inlineImages"]) {
            for (const file of body.getAll(key)) {
              if (typeof file === "string") return json(400, { error: "invalid_draft" });
              attachments.push({ filename: file.name, contentType: file.type, sizeBytes: file.size,
                ...(key === "inlineImages" ? { contentId: file.name } : {}) });
            }
          }
        }
        const originalSubject = source?.subject || "(no subject)";
        const draft: Draft = {
          id: `draft-${++seq}`, inboxId: b.inboxId, threadId: b.threadId ?? null, sourceThreadId: sourceId ?? null,
          to: b.to ?? null, cc: b.cc ?? [], bcc: b.bcc ?? [], attachments,
          subject: b.threadId ? originalSubject.replace(/^(?:re:\s*)?/i, "Re: ") : b.subject ?? "",
          bodyText: b.bodyHtml === undefined ? null : String(b.bodyHtml).replace(/<[^>]*>/g, "").trim(), bodyHtml: b.bodyHtml || null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        if (!visibleDraft(draft)) return json(403, { error: "forbidden" });
        drafts.unshift(draft);
        return json(201, draft);
      }
      if (method === "GET" && draftId) {
        const draft = drafts.find((row) => row.id === draftId);
        if (draft && !visibleDraft(draft)) return json(403, { error: "forbidden" });
        return draft ? json(200, draft) : json(404, { error: "not_found", message: "Draft not found" });
      }
      if (method === "PATCH" && draftId) {
        const draft = drafts.find(row => row.id === draftId);
        if (!draft) return json(404, { error: "not_found", message: "Draft not found" });
        if (!visibleDraft(draft)) return json(403, { error: "forbidden" });
        const input = body as Partial<Draft>;
        if (input.updatedAt !== draft.updatedAt) return json(409, { error: "draft_changed", message: "This draft changed. Refresh before continuing." });
        if (input.inboxId && input.inboxId !== draft.inboxId) return json(400, { error: "draft_inbox_locked" });
        if (state.draftSendFailure?.body.error === "draft_sending") return json(409, state.draftSendFailure.body);
        for (const field of ["to", "cc", "bcc", "subject", "bodyText", "bodyHtml"] as const) {
          if (input[field] !== undefined) Object.assign(draft, { [field]: input[field] });
        }
        if (input.bodyHtml !== undefined) {
          draft.bodyText = input.bodyHtml?.replace(/<[^>]*>/g, "").trim() ?? "";
          draft.bodyHtml = input.bodyHtml;
        }
        draft.updatedAt = new Date(Math.max(Date.now(), Date.parse(draft.updatedAt) + 1)).toISOString();
        return json(200, draft);
      }
      if (method === "GET") {
        const q = url.searchParams.get("q")?.toLowerCase();
        const inboxId = url.searchParams.get("inboxId");
        const podId = url.searchParams.get("podId");
        const source = url.searchParams.get("sourceThreadId");
        const matches = drafts.filter(row => visibleDraft(row) &&
          (!inboxId || row.inboxId === inboxId) &&
          (!podId || state.inboxes.find(i => i.id === row.inboxId)?.podId === podId) &&
          (!source || row.sourceThreadId === source) &&
          (!q || [row.to, row.subject, row.bodyText].some(field => field?.toLowerCase().includes(q))));
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        return json(200, { data: matches.slice(offset, offset + limit), total: matches.length });
      }
    }

    if (method === "POST" && path === "/v1/inboxes") {
      const b = (body ?? {}) as { mailboxName?: string; displayName?: string; domain?: string; podId?: string };
      const custom = b.domain ? state.domains?.find((d) => d.domain === b.domain) : undefined;
      if (b.domain && b.domain !== "omail.sh" && !custom) {
        return json(400, { error: "invalid_domain", message: "Domain is not verified or does not belong to your account" });
      }
      if (custom?.podId && custom.podId !== b.podId) {
        return json(400, { error: "invalid_domain", message: "This domain is not available in the selected pod" });
      }
      const inbox: FakeInbox = {
        id: `inbox-new-${++seq}`,
        address: `${b.mailboxName ?? `agent${seq}`}@${b.domain ?? "omail.sh"}`,
        displayName: b.displayName ?? null,
      };
      state.inboxes.push(inbox);
      return json(201, inbox);
    }

    if ((m = path.match(/^\/v1\/inboxes\/([^/]+)$/)) && method === "PATCH") {
      const inbox = state.inboxes.find((i) => i.id === m![1]);
      if (!inbox) return json(404, { error: "not_found", message: "Inbox not found" });
      const b = (body ?? {}) as { displayName?: string | null; forwardTo?: string | null; forwardWhen?: string };
      if (b.displayName !== undefined) inbox.displayName = b.displayName;
      if (b.forwardTo !== undefined) {
        inbox.forwardTo = b.forwardTo;
        inbox.forwardStatus = b.forwardTo ? "pending" : null;
        inbox.forwardWhen = b.forwardTo ? (b.forwardWhen ?? inbox.forwardWhen ?? "always") : null;
      } else if (b.forwardWhen !== undefined) inbox.forwardWhen = b.forwardWhen;
      return json(200, inbox);
    }

    if ((m = path.match(/^\/v1\/inboxes\/([^/]+)\/messages$/)) && method === "GET") {
      const direction = url.searchParams.get("direction");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const all = Object.values(state.threads)
        .filter((t) => t.inboxId === m![1] && !t.trashed)
        .flatMap((t) => t.messages.map((msg) => ({ ...msg, threadId: t.id, subject: t.subject })))
        .filter((msg) => !direction || msg.direction === direction)
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      return json(200, { data: all.slice(offset, offset + limit), total: all.length });
    }

    if ((m = path.match(/^\/v1\/threads\/([^/]+)$/)) && method === "DELETE") {
      const t = state.threads[m[1]];
      if (!t || t.trashed) return json(404, { error: "not_found", message: "Thread not found" });
      t.trashed = true;
      res.writeHead(204);
      return res.end();
    }

    if ((m = path.match(/^\/v1\/messages\/([^/]+)$/)) && method === "DELETE") {
      const t = Object.values(state.threads).find((x) => x.messages.some((msg) => msg.id === m![1]));
      if (!t) return json(404, { error: "not_found", message: "Message not found" });
      t.messages = t.messages.filter((msg) => msg.id !== m![1]);
      res.writeHead(204);
      return res.end();
    }

    if ((m = path.match(/^\/v1\/inboxes\/([^/]+)$/)) && method === "GET") {
      const inbox = state.inboxes.find((i) => i.id === m![1]);
      return inbox ? json(200, inbox) : json(404, { error: "not_found", message: "Inbox not found" });
    }

    if ((m = path.match(/^\/v1\/inboxes\/([^/]+)\/threads$/)) && method === "GET") {
      const isRead = url.searchParams.get("isRead");
      const data = Object.values(state.threads)
        .filter((t) => t.inboxId === m![1])
        .filter((t) => (isRead === null ? true : String(t.isRead) === isRead))
        .map(({ id, subject, lastMessageAt, isRead }) => ({ id, subject, lastMessageAt, isRead }));
      return json(200, { data });
    }

    if ((m = path.match(/^\/v1\/inboxes\/([^/]+)\/send$/)) && method === "POST") {
      if (state.sendFailure) return json(state.sendFailure.status, state.sendFailure.body);
      const b = (body ?? {}) as { threadId?: string };
      return json(201, { id: `msg-sent-${++seq}`, threadId: b.threadId ?? `thread-new-${seq}` });
    }

    if ((m = path.match(/^\/v1\/inboxes\/([^/]+)\/api-keys$/)) && method === "POST") {
      return json(201, { id: `key-${++seq}`, token: `om_minted_${seq}`, last4: "abcd" });
    }

    if ((m = path.match(/^\/v1\/threads\/([^/]+)\/messages$/)) && method === "GET") {
      const t = state.threads[m[1]];
      if (!t || t.trashed) return json(404, { error: "not_found", message: "Thread not found" });
      return json(200, {
        threadId: t.id,
        inboxId: t.inboxId,
        subject: t.subject,
        isRead: t.isRead,
        data: t.messages,
      });
    }

    if ((m = path.match(/^\/v1\/threads\/([^/]+)$/)) && method === "PATCH") {
      const t = state.threads[m[1]];
      if (!t) return json(404, { error: "not_found", message: "Thread not found" });
      const b = (body ?? {}) as { isRead?: boolean };
      if (typeof b.isRead === "boolean") t.isRead = b.isRead;
      return json(200, { id: t.id, isRead: t.isRead });
    }

    if ((m = path.match(/^\/v1\/attachments\/([^/]+)\/([^/]+)\/text$/)) && method === "GET") {
      const filename = decodeURIComponent(m[2]);
      const att = state.attachments[`${m[1]}/${filename}`];
      if (!att) return json(404, { error: "not_found", message: "Attachment not found" });
      return json(200, { filename, inboxId: att.inboxId, text: att.text, contentType: att.contentType });
    }

    if ((m = path.match(/^\/v1\/attachments\/([^/]+)\/([^/]+)$/)) && method === "GET") {
      const filename = decodeURIComponent(m[2]);
      const att = state.attachments[`${m[1]}/${filename}`];
      if (!att) return json(404, { error: "not_found", message: "Attachment not found" });
      const body = att.bytes ?? Buffer.from(att.text, "utf8");
      const type = att.contentType ?? "application/octet-stream";
      if (att.omitContentLength) {
        res.writeHead(200, { "content-type": type });
        const cut = Math.min(1, body.length);
        if (cut) res.write(body.subarray(0, cut));
        if (body.length > cut) res.write(body.subarray(cut));
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": type,
        "content-length": String(att.contentLength ?? body.length),
      });
      res.end(body);
      return;
    }

    if (method === "POST" && path === "/v1/feedback") return json(201, { ok: true });
    if (method === "GET" && path === "/v1/domains") {
      const domains = state.domains ?? [];
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return json(200, { data: domains.slice(offset, offset + limit), total: domains.length });
    }

    if ((m = path.match(/^\/v1\/domains\/([^/]+)(\/verify)?$/)) && (method === "GET" || method === "POST")) {
      const d = state.domains?.find((x) => x.id === m![1]);
      if (!d) return json(404, { error: "not_found", message: "Domain not found" });
      return json(200, { ...d, records: [] });
    }

    return json(404, { error: "not_found", message: `No fake route for ${method} ${path}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    get state() {
      return state;
    },
    requests,
    calls: (method, path) => requests.filter((r) => r.method === method && path.test(r.path)),
    reset(next) {
      state = next;
      requests.length = 0;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
