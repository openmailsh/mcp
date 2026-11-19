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

/**
 * The attachment download is the file itself. `size` is Content-Length when
 * the server sent one; otherwise the body was larger than `limit` and was
 * discarded before we knew the exact length.
 */
export class PayloadTooLargeError extends Error {
  constructor(
    public readonly limit: number,
    public readonly size: number | null,
    public readonly contentType: string | null,
    public readonly filename?: string,
  ) {
    super(size == null ? `Response exceeds ${limit} bytes` : `Response is ${size} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

export type BinaryResponse = {
  bytes: Buffer;
  contentType: string | null;
  filename?: string;
};

/** The OpenMail download response includes the original UTF-8 filename. */
function attachmentFilename(disposition: string | null): string | undefined {
  const encoded = disposition?.match(/;\s*filename\*=UTF-8''([^;]+)$/i)?.[1];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export type OpenMailApi = {
  get: (path: string) => Promise<unknown>;
  /** GET that returns the body bytes. `request()` is JSON-only and would drop a file. */
  getBinary: (path: string, maxBytes: number) => Promise<BinaryResponse>;
  post: (path: string, body?: unknown) => Promise<unknown>;
  patch: (path: string, body?: unknown) => Promise<unknown>;
  delete: (path: string, body?: unknown) => Promise<unknown>;
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
        // Only claim JSON when there is a body: the API rejects a JSON
        // content type with an empty body (DELETE), as 400 empty_body.
        ...(body === undefined || body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        "x-openmail-client": "mcp",
      },
      body: body instanceof FormData ? body : JSON.stringify(body),
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

  async function readError(res: Response): Promise<ApiError> {
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    return new ApiError(
      res.status,
      typeof json.error === "string" ? json.error : "api_error",
      json.message || json.error || "OpenMail request failed",
      json,
    );
  }

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await send(method, path, body);
    if (!res.ok) throw await readError(res);
    return (await res.json().catch(() => ({}))) as unknown;
  }

  async function getBinary(path: string, maxBytes: number): Promise<BinaryResponse> {
    const res = await send("GET", path);
    const contentType = res.headers.get("content-type");
    if (!res.ok) throw await readError(res);
    const filename = attachmentFilename(res.headers.get("content-disposition"));

    // Stop before buffering a 25 MB mail attachment into the tool result.
    const declared = res.headers.get("content-length");
    const declaredSize = declared == null ? NaN : Number(declared);
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new PayloadTooLargeError(maxBytes, declaredSize, contentType, filename);
    }

    if (!res.body) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new PayloadTooLargeError(maxBytes, bytes.length, contentType, filename);
      return { bytes, contentType, filename };
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new PayloadTooLargeError(maxBytes, null, contentType, filename);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return { bytes: Buffer.concat(chunks), contentType, filename };
  }

  return {
    get: (path) => request("GET", path),
    getBinary,
    post: (path, body) => request("POST", path, body ?? {}),
    patch: (path, body) => request("PATCH", path, body ?? {}),
    delete: (path, body) => request("DELETE", path, body),
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
