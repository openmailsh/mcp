import { z } from "zod";
import { recipientInput } from "./recipients.js";

const fileBytes = z.string()
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, "Expected base64 file content")
  .refine(value => value.length % 4 === 0, "Expected padded base64 file content");
const attachment = z.object({
  filename: z.string().min(1),
  content_type: z.string().min(1),
  content_base64: fileBytes,
});
const inlineImage = z.object({
  content_id: z.string().regex(/^inline-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}@openmail$/),
  content_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  content_base64: fileBytes,
});

export const draftFields = z.object({
  inbox_id: z.string().min(1).describe("Inbox that owns and sends this draft. Use the inbox of the source thread when composing from a conversation."),
  thread_id: z.string().min(1).optional().describe("Reply in this thread and inherit its subject. The reply also appears under this source thread."),
  source_thread_id: z.string().min(1).optional().describe("Conversation this draft was composed from. For forwards, pass this alone. If thread_id is supplied the two IDs must match."),
  to: recipientInput(true).optional().describe("Visible To recipients, if known. Pass one address or an ordered list of up to 100."),
  cc: z.array(z.string().email().max(320)).max(100).optional().describe("Visible copy recipients."),
  bcc: z.array(z.string().email().max(320)).max(100).optional().describe("Blind copy recipients."),
  subject: z.string().max(998).optional().describe("Draft subject. Replies inherit their subject from the thread."),
  body_html: z.string().max(500000).optional().describe("HTML message body. This is the only accepted body input; OpenMail generates plain text automatically and imports embedded and public HTTP(S) raster images. Omit for an incomplete draft."),
  attachments: z.array(attachment).optional().describe("Regular files with base64-encoded content. The whole MCP request, including base64, must fit in 4 MiB."),
  inline_images: z.array(inlineImage).optional().describe("Images referenced in the HTML as cid:inline-<UUID>@openmail. Supply the same identifier as content_id."),
});

export type DraftInput = Omit<z.infer<typeof draftFields>, "inbox_id"> & { inbox_id?: string };

export const editDraftFields = z.object({
  draft_id: z.string().min(1).describe("Saved draft id from get_draft."),
  updated_at: z.string().datetime({ offset: true }).describe("Exact updated_at from the draft being edited. Never substitute a newer version without reconciling the requested changes."),
  inbox_id: z.string().min(1).optional().describe("Optional ownership check. Must match the original sending inbox."),
  to: recipientInput(true).nullable().optional().describe("Replace visible To recipients with one address or a list of up to 100. Use null or [] to clear."),
  cc: z.array(z.string().email().max(254)).max(100).optional().describe("Replace copy recipients; [] clears them."),
  bcc: z.array(z.string().email().max(254)).max(100).optional().describe("Replace blind-copy recipients; [] clears them."),
  subject: z.string().max(998).optional().describe("Replace the subject; empty string clears it. Reply drafts must retain their original subject."),
  body_html: z.string().max(500000).optional().describe("Replacement HTML body. OpenMail generates plain text automatically. Empty string clears the body; omit to preserve it. Retain cid: references for inline images you want to keep."),
});
export type EditDraftInput = z.infer<typeof editDraftFields>;

export function editDraftPayload(args: EditDraftInput, inboxId?: string) {
  if ([args.to, args.cc, args.bcc, args.subject, args.body_html].every(value => value === undefined)) throw new Error("Supply at least one draft content change.");
  return {
    updatedAt: args.updated_at,
    ...(inboxId ? { inboxId } : {}),
    ...(args.to !== undefined ? { to: args.to } : {}),
    ...(args.cc !== undefined ? { cc: args.cc } : {}),
    ...(args.bcc !== undefined ? { bcc: args.bcc } : {}),
    ...(args.subject !== undefined ? { subject: args.subject } : {}),
    ...(args.body_html !== undefined ? { bodyHtml: args.body_html } : {}),
  };
}

export function draftPayload(args: DraftInput, inboxId: string): FormData | Record<string, string | string[] | undefined> {
  const fields = {
    inboxId,
    threadId: args.thread_id,
    sourceThreadId: args.source_thread_id,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    bodyHtml: args.body_html,
  };
  if (!args.attachments?.length && !args.inline_images?.length) return fields;

  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    form.append(key, Array.isArray(value) ? JSON.stringify(value) : value);
  }
  for (const file of args.attachments ?? []) {
    form.append("attachments", new Blob([Buffer.from(file.content_base64, "base64")], { type: file.content_type }), file.filename);
  }
  for (const image of args.inline_images ?? []) {
    form.append("inlineImages", new Blob([Buffer.from(image.content_base64, "base64")], { type: image.content_type }), image.content_id);
  }
  return form;
}
