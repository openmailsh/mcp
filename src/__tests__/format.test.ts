import { describe, expect, it } from "vitest";
import { formatThread, htmlToText, stripQuotedReply } from "../format";

describe("forwarded mail", () => {
  const forward =
    "FYI, see below.\n\n---------- Forwarded message ---------\nFrom: News <news@x.com>\nDate: Mon, 9 Nov 2026\nSubject: Weekly\nTo: me@x.com\n\nThe newsletter body.";

  it("keeps a Gmail forward whole", () => {
    expect(stripQuotedReply(forward)).toBe(forward);
  });

  it("keeps an Apple Mail forward whole", () => {
    const body = "See this.\n\nBegin forwarded message:\n\nFrom: A <a@x.com>\nDate: Monday\n\nOriginal text.";
    expect(stripQuotedReply(body)).toBe(body);
  });

  it("still strips a reply quote above a forward", () => {
    expect(stripQuotedReply(`Thanks!\n\nOn Mon, 9 Nov 2026, B <b@x.com> wrote:\n> ${forward}`)).toBe("Thanks!");
  });

  it("keeps an Outlook forward whole when the subject says Fwd", () => {
    const out = formatThread({
      threadId: "t1",
      subject: "FW: Weekly",
      messages: [
        {
          id: "m1",
          direction: "inbound",
          fromAddr: "me@x.com",
          bodyText: "FYI\n\n________________________________\nFrom: News <news@x.com>\nSent: Monday\n\nThe newsletter body.",
        },
      ],
    });
    expect(out).toContain("The newsletter body.");
  });
});

describe("HTML-only mail", () => {
  it("falls back to bodyHtml and keeps link URLs", () => {
    const out = formatThread({
      threadId: "t1",
      subject: "Confirm",
      messages: [
        {
          id: "m1",
          direction: "inbound",
          fromAddr: "noreply@x.com",
          bodyText: "",
          bodyHtml:
            '<html><head><style>p{}</style></head><body><p>Hi &amp; welcome</p><a href="https://x.com/confirm?t=1&amp;u=2">Confirm email</a></body></html>',
        },
      ],
    });
    expect(out).toContain("Hi & welcome");
    expect(out).toContain("Confirm email (https://x.com/confirm?t=1&u=2)");
    expect(out).not.toContain("(empty body)");
  });

  it("shows a bare URL once when the link text is the URL", () => {
    expect(htmlToText('<a href="https://x.com/a">https://x.com/a</a>')).toBe("https://x.com/a");
  });
});

describe("stripQuotedReply", () => {
  it("cuts a Gmail-style quote header, including one that wrapped", () => {
    expect(stripQuotedReply("Yes please.\n\nOn Fri, 25 Sep 2026 at 11:40, A <a@x.com> wrote:\n> Shall I?")).toBe("Yes please.");
    expect(stripQuotedReply("Yes please.\n\nOn Fri, 25 Sep 2026 at 11:40, A <a@x.com>\nwrote:\n> Shall I?")).toBe("Yes please.");
  });

  it("cuts Outlook separators", () => {
    expect(stripQuotedReply("Ok.\n\n-----Original Message-----\nFrom: a@x.com\nSent: Friday")).toBe("Ok.");
    expect(stripQuotedReply("Ok.\n\nFrom: A <a@x.com>\nSent: Friday, 25 Sep\nTo: b@x.com\n\nhello")).toBe("Ok.");
  });

  it("drops a trailing block of > lines without a header", () => {
    expect(stripQuotedReply("Sure.\n> old\n> older\n")).toBe("Sure.");
  });

  it("keeps the body when it is nothing but a quote", () => {
    const body = "> forwarded\n> text";
    expect(stripQuotedReply(body)).toBe(body);
  });

  it("does not touch a body without quotes", () => {
    expect(stripQuotedReply("I wrote: nothing here.\nOn time.")).toBe("I wrote: nothing here.\nOn time.");
  });

  it("does not treat an On-line plus a later wrote: as a quote header", () => {
    const body =
      "Thanks for the update.\n\nOn Monday the client called.\nI wrote:\nPlease follow up tomorrow.";
    expect(stripQuotedReply(body)).toBe(body);
  });
});
