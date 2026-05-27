import { describe, expect, it } from "vitest";
import {
  escapeXml,
  messageMlToPlain,
  plainToMessageMl,
  stripToPlainMessageMl,
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

  it("turns </p> and </li> into newlines so paragraphs/lists stay readable", () => {
    const xml = "<messageML><p>first</p><p>second</p><ul><li>a</li><li>b</li></ul></messageML>";
    const text = messageMlToPlain(xml).text;
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text).toContain("a");
    expect(text).toContain("b");
    expect(text.split("\n").length).toBeGreaterThan(1);
  });

  it("drops anchor markup but keeps the link text (URL currently lost — known limitation)", () => {
    const xml = '<messageML>see <a href="https://example.com">our docs</a></messageML>';
    expect(messageMlToPlain(xml).text).toBe("see our docs");
  });

  it("strips code and pre tags but keeps their content", () => {
    const xml = "<messageML>run <code>foo bar</code> then <pre>baz\nqux</pre></messageML>";
    const text = messageMlToPlain(xml).text;
    expect(text).toContain("foo bar");
    expect(text).toContain("baz");
    expect(text).toContain("qux");
  });

  it("strips blockquote markup but keeps text", () => {
    const xml = "<messageML><blockquote>quoted</blockquote> reply</messageML>";
    expect(messageMlToPlain(xml).text).toContain("quoted");
    expect(messageMlToPlain(xml).text).toContain("reply");
  });

  it("passes Japanese text through unchanged", () => {
    const original = "こんにちは、世界！\n改行も保つ";
    const result = messageMlToPlain(plainToMessageMl({ text: original }));
    expect(result.text).toBe(original);
  });

  it("returns empty string for empty body", () => {
    expect(messageMlToPlain("<messageML></messageML>").text).toBe("");
    expect(messageMlToPlain("").text).toBe("");
  });

  it("decodes numeric HTML entities", () => {
    // ☃ is U+2603, decimal 9731
    expect(messageMlToPlain("<messageML>snow: &#9731;</messageML>").text).toBe("snow: ☃");
  });
});

describe("stripToPlainMessageMl", () => {
  it("wraps plain text in <messageML> tags", () => {
    expect(stripToPlainMessageMl("hello world")).toBe("<messageML>hello world</messageML>");
  });

  it("converts newlines to <br/>", () => {
    expect(stripToPlainMessageMl("line one\nline two")).toBe(
      "<messageML>line one<br/>line two</messageML>",
    );
    expect(stripToPlainMessageMl("crlf\r\nstyle")).toBe(
      "<messageML>crlf<br/>style</messageML>",
    );
  });

  it("escapes XML special characters in the body", () => {
    expect(stripToPlainMessageMl("a & b < c > d")).toBe(
      "<messageML>a &amp; b  d</messageML>",
    );
    // The '<' / '>' got dropped as faux-tags by the strip step before escaping;
    // that's by design — the goal is "guaranteed valid", not "perfectly faithful".
  });

  it("strips arbitrary tag-like fragments that would have broken the MessageML parse", () => {
    expect(stripToPlainMessageMl("<div>hi <broken")).toBe("<messageML>hi </messageML>");
    expect(stripToPlainMessageMl("<unclosed attr=\"x")).toBe("<messageML></messageML>");
    expect(stripToPlainMessageMl("<code language=\"weird>nope</code>")).toBe(
      "<messageML>nope</messageML>",
    );
  });

  it("handles empty / undefined-ish input safely", () => {
    expect(stripToPlainMessageMl("")).toBe("<messageML></messageML>");
    // @ts-expect-error — intentionally testing the runtime guard
    expect(stripToPlainMessageMl(undefined)).toBe("<messageML></messageML>");
  });

  it("survives input that looks dangerous (script tags, unbalanced quotes)", () => {
    expect(stripToPlainMessageMl("<script>alert('xss')</script>")).toBe(
      "<messageML>alert(&apos;xss&apos;)</messageML>",
    );
  });
});
