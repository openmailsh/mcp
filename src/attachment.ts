import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Bytes we will place in a tool result. Base64 adds about a third on top. */
export const ATTACHMENT_INLINE_LIMIT = 4 * 1024 * 1024;

const VISION_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  md: "text/markdown",
  svg: "image/svg+xml",
};

/** A specific type from a Content-Type header. octet-stream means "unknown". */
export function specificMime(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") return null;
  return mime;
}

function sniffMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const sig = bytes.subarray(0, 6).toString("ascii");
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  return null;
}

function mimeFromFilename(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return null;
  return EXT_MIME[filename.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The download endpoint is documented as application/octet-stream, so the
 * header often does not say what the file is. Prefer a real Content-Type,
 * then the magic bytes, then the filename.
 */
export function resolveMime(contentType: string | null | undefined, filename: string, bytes?: Buffer): string {
  return (
    specificMime(contentType) ??
    (bytes ? sniffMime(bytes) : null) ??
    mimeFromFilename(filename) ??
    "application/octet-stream"
  );
}

export function formatByteSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const unit = n < 1024 * 1024 ? n / 1024 : n / (1024 * 1024);
  const label = n < 1024 * 1024 ? "KB" : "MB";
  const rounded = unit >= 10 ? Math.round(unit) : Math.round(unit * 10) / 10;
  return `${rounded} ${label}`;
}

function isTextual(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function tooLargeMessage(filename: string, mime: string, size: number | null, limit = ATTACHMENT_INLINE_LIMIT): string {
  const how = size == null ? `larger than ${formatByteSize(limit)}` : `${size} bytes (${formatByteSize(size)})`;
  return [
    `${filename} is ${how} (${mime}), over the ${formatByteSize(limit)} limit for returning the file in the tool result.`,
    "OpenMail does not issue a short-lived signed download URL — the file is only available with this session's credential — so it cannot be handed off as a link.",
    "Use get_attachment_text for the extracted text.",
  ].join(" ");
}

function attachmentUri(messageId: string, filename: string): string {
  return `openmail://attachment/${encodeURIComponent(messageId)}/${encodeURIComponent(filename)}`;
}

/**
 * Image blocks for the types vision clients actually render. Everything else
 * is an embedded resource: UTF-8 text when the type is textual, otherwise a
 * base64 blob. SVG stays text — it is not a vision image, and it can carry script.
 */
export function buildAttachmentContent(input: {
  messageId: string;
  filename: string;
  bytes: Buffer;
  contentType: string | null;
  limit?: number;
}): CallToolResult {
  const limit = input.limit ?? ATTACHMENT_INLINE_LIMIT;
  const mime = resolveMime(input.contentType, input.filename, input.bytes);
  if (input.bytes.length > limit) {
    return {
      content: [{ type: "text", text: tooLargeMessage(input.filename, mime, input.bytes.length, limit) }],
      isError: true,
    };
  }
  const caption = `${input.filename} (${mime}, ${formatByteSize(input.bytes.length)})`;
  if (VISION_IMAGE.has(mime)) {
    return {
      content: [
        { type: "text", text: caption },
        { type: "image", data: input.bytes.toString("base64"), mimeType: mime },
      ],
    };
  }
  const uri = attachmentUri(input.messageId, input.filename);
  const decoded = isTextual(mime) ? decodeUtf8(input.bytes) : null;
  if (decoded != null) {
    return {
      content: [
        { type: "text", text: caption },
        { type: "resource", resource: { uri, mimeType: mime, text: decoded } },
      ],
    };
  }
  return {
    content: [
      { type: "text", text: caption },
      { type: "resource", resource: { uri, mimeType: mime, blob: input.bytes.toString("base64") } },
    ],
  };
}
