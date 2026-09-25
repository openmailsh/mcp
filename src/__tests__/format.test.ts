import { describe, expect, it } from "vitest";
import { stripQuotedReply } from "../format";

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
