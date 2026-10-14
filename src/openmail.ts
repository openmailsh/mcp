export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export type OpenMailApi = {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body?: unknown) => Promise<unknown>;
  patch: (path: string, body?: unknown) => Promise<unknown>;
  delete: (path: string) => Promise<unknown>;
};

export function createOpenMailApi(
  baseUrl: string,
  token: string,
): OpenMailApi {
  const root = baseUrl.replace(/\/+$/, "");

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-openmail-client": "mcp",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    try {
      return await fetch(`${root}${path}`, init);
    } catch (err) {
      // A dropped connection ("fetch failed") is worth one retry on a read.
      // Never on a write: a send that reached the API must not go out twice.
      if (method !== "GET") throw err;
      return fetch(`${root}${path}`, init);
    }
  }

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await send(method, path, body);
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      throw new ApiError(
        res.status,
        typeof json.error === "string" ? json.error : "api_error",
        json.message || json.error || "OpenMail request failed",
        json,
      );
    }
    return json;
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body ?? {}),
    patch: (path, body) => request("PATCH", path, body ?? {}),
    delete: (path) => request("DELETE", path),
  };
}

export type MeResponse = {
  customerId: string;
  plan: string;
  apiKeyScope:
    | "account"
    | { podId: string | null; inboxId: string | null };
  mcpScopes: string[] | null;
};
