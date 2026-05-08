import { describe, expect, it } from "vitest";
import {
  escapeXml,
  messageMlToPlain,
  plainToMessageMl,
  unescapeXml,
} from "../src/messageml.js";

describe("escapeXml", () => {
  it("escapes the five XML special characters", () => {
    expect(escapeXml(`<a href="x" 'y' & z>`)).toBe(
      "&lt;a href=&quot;x&quot; &apos;y&apos; &amp; z&gt;",
    );
  });
});

describe("unescapeXml", () => {
  it("reverses XML entities", () => {
    expect(unescapeXml("&lt;b&gt;hi&lt;/b&gt;")).toBe("<b>hi</b>");
    expect(unescapeXml("&amp;amp;")).toBe("&amp;");
    expect(unescapeXml("snowman: &#9731;")).toBe("snowman: ☃");
  });
});

describe("plainToMessageMl", () => {
  it("wraps plain text and escapes XML", () => {
    expect(plainToMessageMl({ text: "hello <world> & friends" })).toBe(
      "<messageML>hello &lt;world&gt; &amp; friends</messageML>",
    );
  });

  it("renders mention tags", () => {
    const out = plainToMessageMl({
      text: "ping",
      mentions: [{ kind: "user", userId: 123 }, { kind: "email", email: "a@b.com" }],
    });
    expect(out).toContain('<mention uid="123"/>');
    expect(out).toContain('<mention email="a@b.com"/>');
    expect(out).toContain("ping");
  });

  it("converts newlines to <br/>", () => {
    expect(plainToMessageMl({ text: "line1\nline2\nline3" })).toBe(
      "<messageML>line1<br/>line2<br/>line3</messageML>",
    );
  });

  it("appends emojis", () => {
    expect(plainToMessageMl({ text: "yay", emojis: ["smile"] })).toContain(
      '<emoji shortcode="smile"/>',
    );
  });
});

describe("messageMlToPlain", () => {
  it("parses mentions, emojis, and br tags", () => {
    const xml =
      '<messageML><mention uid="42"/> hi <emoji shortcode="tada"/><br/>second line</messageML>';
    const result = messageMlToPlain(xml);
    expect(result.text).toContain(":tada:");
    expect(result.text).toContain("second line");
    expect(result.text.split("\n")).toHaveLength(2);
    expect(result.mentions).toEqual([{ userId: 42 }]);
    expect(result.emojis).toEqual(["tada"]);
  });

  it("strips formatting tags but keeps content", () => {
    const xml = "<messageML><b>bold</b> <i>italic</i> <p>para</p></messageML>";
    expect(messageMlToPlain(xml).text).toBe("bold italic para");
  });

  it("captures mention by email", () => {
    const xml = '<messageML><mention email="a@b.com"/> hi</messageML>';
    expect(messageMlToPlain(xml).mentions).toEqual([{ email: "a@b.com" }]);
  });

  it("round-trips a plain message through both directions", () => {
    const original = "hello & welcome\nline 2";
    const ml = plainToMessageMl({ text: original });
    expect(messageMlToPlain(ml).text).toBe(original);
  });
});
