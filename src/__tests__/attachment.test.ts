import { describe, expect, it } from "vitest";
import { createOpenMailApi, PayloadTooLargeError } from "../openmail.js";
import {
  ATTACHMENT_INLINE_LIMIT,
  buildAttachmentContent,
  formatByteSize,
  resolveMime,
} from "../attachment.js";
import { startFakeOpenMailApi } from "./helpers/fake-openmail-api.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type Block = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
};

function blocks(result: ReturnType<typeof buildAttachmentContent>): Block[] {
  return result.content as Block[];
}

describe("buildAttachmentContent", () => {
  it("returns a png as an image block even when the API says octet-stream", () => {
    const result = buildAttachmentContent({
      messageId: "msg-1",
      filename: "scan.bin",
      bytes: PNG,
      contentType: "application/octet-stream",
    });
    expect(result.isError).toBeFalsy();
    const content = blocks(result);
    expect(content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: PNG.toString("base64"),
    });
    expect(content[0].text).toContain("scan.bin");
    expect(content[0].text).toContain("image/png");
  });

  it("trusts a specific Content-Type over the filename", () => {
    expect(resolveMime("image/jpeg; charset=binary", "photo.png", PNG)).toBe("image/jpeg");
  });

  it("returns a pdf as a base64 resource blob", () => {
    const bytes = Buffer.from("%PDF-1.4 fake");
    const result = buildAttachmentContent({
      messageId: "msg-1",
      filename: "invoice.pdf",
      bytes,
      contentType: "application/octet-stream",
    });
    const content = blocks(result);
    expect(content.map((c) => c.type)).toEqual(["text", "resource"]);
    expect(content[1].resource).toEqual({
      uri: "openmail://attachment/msg-1/invoice.pdf",
      mimeType: "application/pdf",
      blob: bytes.toString("base64"),
    });
    expect(content[1].resource?.text).toBeUndefined();
  });

  it("returns utf-8 text as a resource text, and encodes the uri", () => {
    const result = buildAttachmentContent({
      messageId: "msg/1",
      filename: "notes copy.csv",
      bytes: Buffer.from("a,b\n1,2\n"),
      contentType: null,
    });
    const content = blocks(result);
    expect(content[1].resource).toEqual({
      uri: "openmail://attachment/msg%2F1/notes%20copy.csv",
      mimeType: "text/csv",
      text: "a,b\n1,2\n",
    });
    expect(content[1].resource?.blob).toBeUndefined();
  });

  it("does not send svg as an image block", () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const result = buildAttachmentContent({
      messageId: "msg-1",
      filename: "logo.svg",
      bytes: svg,
      contentType: "image/svg+xml",
    });
    expect(blocks(result).some((c) => c.type === "image")).toBe(false);
    expect(blocks(result)[1].resource?.text).toBe(svg.toString("utf8"));
  });

  it("falls back to a blob when a text type is not utf-8", () => {
    const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
    const result = buildAttachmentContent({
      messageId: "msg-1",
      filename: "broken.txt",
      bytes,
      contentType: "text/plain",
    });
    expect(blocks(result)[1].resource?.blob).toBe(bytes.toString("base64"));
    expect(blocks(result)[1].resource?.text).toBeUndefined();
  });

  it("refuses a file over the inline limit without embedding it", () => {
    const result = buildAttachmentContent({
      messageId: "msg-1",
      filename: "big.pdf",
      bytes: Buffer.from("%PDF-too-big"),
      contentType: "application/pdf",
      limit: 4,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const message = blocks(result)[0].text ?? "";
    expect(message).toContain("big.pdf");
    expect(message).toContain("get_attachment_text");
    expect(message).toContain("signed download URL");
    expect(message).not.toContain("JVBERi");
  });

  it("formats the 4 MB cap as 4 MB", () => {
    expect(formatByteSize(ATTACHMENT_INLINE_LIMIT)).toBe("4 MB");
    expect(formatByteSize(Math.round(1.5 * 1024 * 1024))).toBe("1.5 MB");
  });
});

describe("getBinary", () => {
  it("returns the file bytes and stops when Content-Length is over the cap", async () => {
    const api = await startFakeOpenMailApi({
      tokens: {
        om_test: { customerId: "cust-1", plan: "developer", apiKeyScope: "account", mcpScopes: null },
      },
      inboxes: [],
      threads: {},
      attachments: {
        "msg-1/pixel.png": {
          inboxId: "inbox-a",
          text: "",
          bytes: PNG,
          contentType: "image/png",
        },
        "msg-1/huge.bin": {
          inboxId: "inbox-a",
          text: "tiny",
          contentType: "application/octet-stream",
          contentLength: 50,
        },
        "msg-1/stream.bin": {
          inboxId: "inbox-a",
          text: "0123456789abcdef",
          contentType: "application/octet-stream",
          omitContentLength: true,
        },
      },
    });
    try {
      const client = createOpenMailApi(api.url, "om_test");
      const file = await client.getBinary("/v1/attachments/msg-1/pixel.png", 1024);
      expect(file.contentType).toBe("image/png");
      expect(file.bytes.equals(PNG)).toBe(true);

      await expect(client.getBinary("/v1/attachments/msg-1/huge.bin", 16)).rejects.toMatchObject({
        name: "PayloadTooLargeError",
        size: 50,
        limit: 16,
        contentType: "application/octet-stream",
      });

      await expect(client.getBinary("/v1/attachments/msg-1/stream.bin", 8)).rejects.toBeInstanceOf(PayloadTooLargeError);
      try {
        await client.getBinary("/v1/attachments/msg-1/stream.bin", 8);
      } catch (err) {
        expect(err).toBeInstanceOf(PayloadTooLargeError);
        expect((err as PayloadTooLargeError).size).toBeNull();
      }
    } finally {
      await api.close();
    }
  });
});
