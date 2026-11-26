import { z } from "zod";

const email = z.string().trim().email().max(254);

/** Keep scalar inputs compatible while accepting an ordered list of mailboxes. */
export function recipientInput(draft = false) {
  const text = z.string().trim().refine(value => {
    const addresses = value.split(",");
    return (!draft || addresses.length <= 100) && addresses.every(address => email.safeParse(address).success);
  }, "Enter a valid email address for each To recipient");
  const list = z.array(email);
  return z.union([text, draft ? list.max(100) : list.min(1)]);
}

export type MessageRecipients = {
  toRecipients?: string[];
  headerTo?: string | null;
  deliveryRole?: string | null;
  toAddr?: string;
};

export function messageTo(message: MessageRecipients): string | string[] | undefined {
  if (message.toRecipients) {
    return message.toRecipients.length > 1 ? message.toRecipients : message.toRecipients[0];
  }
  return message.headerTo ?? (message.deliveryRole === "cc" ? undefined : message.toAddr);
}

export function recipientText(value: string | string[] | null | undefined): string {
  return Array.isArray(value) ? value.join(", ") : value ?? "";
}
