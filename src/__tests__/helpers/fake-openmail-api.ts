/**
 * In-process stand-in for api.openmail.sh — the one true network boundary of
 * the MCP host. Plain `node:http`, no framework: it serves the handful of /v1
 * routes the tools call, authenticates by looking the bearer token up in
 * `state.tokens`, mutates `state` the way the real API would, and records
 * every request so tests can assert on what crossed the wire.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { MeResponse } from "../../openmail.js";

export type FakeMessage = {
  id: string;
  direction: "inbound" | "outbound";
  fromAddr: string;
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
};

export type FakeInbox = { id: string; address: string; displayName?: string | null };

export type FakeState = {
  /** bearer token → who it is. Anything else is 401. */
  tokens: Record<string, MeResponse>;
  inboxes: FakeInbox[];
  threads: Record<string, FakeThread>;
  attachments: Record<string, { inboxId: string; text: string }>;
  /** When set, GET /v1/me answers with this instead of looking the token up (simulates an API outage). */
  meFailure?: { status: number; body?: unknown };
};

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

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
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

    if (method === "POST" && path === "/v1/inboxes") {
      const b = (body ?? {}) as { mailboxName?: string; displayName?: string };
      const inbox: FakeInbox = {
        id: `inbox-new-${++seq}`,
        address: `${b.mailboxName ?? `agent${seq}`}@omail.sh`,
        displayName: b.displayName ?? null,
      };
      state.inboxes.push(inbox);
      return json(201, inbox);
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
      const b = (body ?? {}) as { threadId?: string };
      return json(201, { id: `msg-sent-${++seq}`, threadId: b.threadId ?? `thread-new-${seq}` });
    }

    if ((m = path.match(/^\/v1\/inboxes\/([^/]+)\/api-keys$/)) && method === "POST") {
      return json(201, { id: `key-${++seq}`, token: `om_minted_${seq}`, last4: "abcd" });
    }

    if ((m = path.match(/^\/v1\/threads\/([^/]+)\/messages$/)) && method === "GET") {
      const t = state.threads[m[1]];
      if (!t) return json(404, { error: "not_found", message: "Thread not found" });
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
      return json(200, { filename, inboxId: att.inboxId, text: att.text });
    }

    if (method === "POST" && path === "/v1/feedback") return json(201, { ok: true });
    if (method === "GET" && path === "/v1/domains") return json(200, { data: [] });

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
