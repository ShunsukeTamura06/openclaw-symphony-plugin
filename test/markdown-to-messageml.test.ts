import { describe, expect, it } from "vitest";
import { markdownToMessageMl, markdownToMessageMlBody } from "../src/markdown-to-messageml.js";

describe("markdownToMessageMl", () => {
  it("wraps an empty string as an empty messageML", () => {
    expect(markdownToMessageMl("")).toBe("<messageML></messageML>");
  });

  it("plain text becomes a single <p>", () => {
    expect(markdownToMessageMl("hello world")).toBe("<messageML><p>hello world</p></messageML>");
  });

  it("XML-escapes special characters in plain text", () => {
    const out = markdownToMessageMl("a < b & c > d");
    expect(out).toContain("a &lt; b &amp; c &gt; d");
    expect(out).not.toContain("<b>"); // not interpreted as a tag
  });
});

describe("headings", () => {
  it("# through ###### map to <h1>–<h6>", () => {
    for (let depth = 1; depth <= 6; depth += 1) {
      const md = `${"#".repeat(depth)} title ${depth}`;
      const ml = markdownToMessageMlBody(md);
      expect(ml).toBe(`<h${depth}>title ${depth}</h${depth}>`);
    }
  });

  it("a heading with bold becomes <hN><b>bold</b> rest</hN>", () => {
    expect(markdownToMessageMlBody("## **重要** な見出し")).toBe(
      "<h2><b>重要</b> な見出し</h2>",
    );
  });
});

describe("inline emphasis", () => {
  it("**bold** -> <b>", () => {
    expect(markdownToMessageMlBody("**hi**")).toBe("<p><b>hi</b></p>");
  });
  it("*italic* -> <i>", () => {
    expect(markdownToMessageMlBody("*hi*")).toBe("<p><i>hi</i></p>");
  });
  it("_italic_ -> <i>", () => {
    expect(markdownToMessageMlBody("_hi_")).toBe("<p><i>hi</i></p>");
  });
  it("~~strike~~ degrades to plain text (Symphony has no strikethrough tag)", () => {
    const out = markdownToMessageMlBody("~~hi~~");
    expect(out).toBe("<p>hi</p>");
    expect(out).not.toContain("<strike");
    expect(out).not.toContain("<s>");
    expect(out).not.toContain("<del");
  });
});

describe("code", () => {
  it("inline `code` -> <code>", () => {
    expect(markdownToMessageMlBody("run `npm test`")).toBe(
      "<p>run <code>npm test</code></p>",
    );
  });

  it("escapes XML special chars inside inline code", () => {
    expect(markdownToMessageMlBody("look at `<div>`")).toContain("<code>&lt;div&gt;</code>");
  });

  it("fenced code blocks -> <pre> with content escaped, language dropped", () => {
    const md = "```ts\nfunction f(x: number) { return x < 10; }\n```";
    const out = markdownToMessageMlBody(md);
    expect(out).toContain("<pre>");
    expect(out).toContain("function f(x: number) { return x &lt; 10; }");
    expect(out).not.toContain('class="lang-ts"');
  });

  it("does NOT interpret Markdown syntax inside code blocks", () => {
    const md = "```\n**not bold** and ## not heading\n```";
    const out = markdownToMessageMlBody(md);
    expect(out).toContain("**not bold**");
    expect(out).toContain("## not heading");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<h2>");
  });
});

describe("lists", () => {
  it("unordered list -> <ul><li>…</li></ul>", () => {
    const md = "- a\n- b\n- c";
    const out = markdownToMessageMlBody(md);
    expect(out).toMatch(/<ul>.*<li>.*a.*<\/li>.*<li>.*b.*<\/li>.*<li>.*c.*<\/li>.*<\/ul>/s);
  });

  it("ordered list -> <ol><li>…</li></ol>", () => {
    const md = "1. one\n2. two";
    const out = markdownToMessageMlBody(md);
    expect(out).toContain("<ol>");
    expect(out).toContain("<li>");
  });

  it("ordered list with non-default start preserves start attr", () => {
    const md = "5. five\n6. six";
    const out = markdownToMessageMlBody(md);
    expect(out).toContain('<ol start="5">');
  });

  it("nested lists are preserved", () => {
    const md = "- parent\n  - child\n  - child2";
    const out = markdownToMessageMlBody(md);
    // The outer <ul> contains a <li> that itself contains a <ul>
    const liChildOpen = out.indexOf("<li>");
    expect(liChildOpen).toBeGreaterThan(0);
    const innerUlOpen = out.indexOf("<ul>", liChildOpen + 1);
    expect(innerUlOpen).toBeGreaterThan(0);
  });
});

describe("blockquote / hr / link / image", () => {
  it("> quoted text degrades to its inner content (Symphony has no <blockquote>)", () => {
    const out = markdownToMessageMlBody("> hello");
    expect(out).toContain("<p>hello</p>");
    expect(out).not.toContain("<blockquote");
  });

  it("multi-paragraph blockquote preserves all paragraphs without wrapper", () => {
    const out = markdownToMessageMlBody("> first\n>\n> second");
    expect(out).toContain("<p>first</p>");
    expect(out).toContain("<p>second</p>");
    expect(out).not.toContain("<blockquote");
  });

  it("--- on its own line -> <hr/>", () => {
    expect(markdownToMessageMlBody("before\n\n---\n\nafter")).toContain("<hr/>");
  });

  it("[text](url) -> <a href=\"url\">text</a> with attr-escaped href", () => {
    const out = markdownToMessageMlBody('see [docs](https://example.com/?q=a&b)');
    expect(out).toContain(
      '<a href="https://example.com/?q=a&amp;b">docs</a>',
    );
  });

  it("![alt](url) falls back to alt text (Symphony has no inline images)", () => {
    const out = markdownToMessageMlBody("![my pic](http://example.com/x.png)");
    expect(out).toContain("my pic");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("http://example.com/x.png");
  });
});

describe("tables (GFM)", () => {
  it("renders a header + body table using <td> in thead (Symphony does NOT support <th>)", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    const out = markdownToMessageMlBody(md);
    expect(out).toContain("<table>");
    // thead cells use <td><b>...</b></td>, never <th>
    expect(out).toContain("<thead><tr><td><b>A</b></td><td><b>B</b></td></tr></thead>");
    expect(out).not.toContain("<th>");
    expect(out).not.toContain("<th ");
    expect(out).toContain("<tbody>");
    expect(out).toContain("<tr><td>1</td><td>2</td></tr>");
    expect(out).toContain("<tr><td>3</td><td>4</td></tr>");
    expect(out).toContain("</table>");
  });

  it("inline markup inside body cells is converted", () => {
    const md = "| col |\n| --- |\n| **bold** |";
    const out = markdownToMessageMlBody(md);
    expect(out).toContain("<td><b>bold</b></td>");
  });
});

describe("task lists (GFM checkboxes)", () => {
  it("unchecked task -> [ ] prefix inside <li> (Symphony <checkbox> is form-only)", () => {
    const out = markdownToMessageMlBody("- [ ] todo");
    expect(out).toMatch(/<li>\[ \]\s*(?:<p>)?todo/);
    expect(out).not.toContain("<input");
    expect(out).not.toContain("<checkbox");
  });

  it("checked task -> [x] prefix inside <li>", () => {
    const out = markdownToMessageMlBody("- [x] done");
    expect(out).toMatch(/<li>\[x\]\s*(?:<p>)?done/);
    expect(out).not.toContain("<input");
  });
});

describe("disallowed-tag guard", () => {
  it("never emits Symphony-unsupported tags", () => {
    const md = [
      "> quote",
      "",
      "~~strike~~",
      "",
      "| A |",
      "| - |",
      "| 1 |",
    ].join("\n");
    const out = markdownToMessageMlBody(md);
    // Use word-boundary-aware patterns so "<thead>" is not mis-matched as "<th>"
    const bannedPatterns: Array<[RegExp, string]> = [
      [/<\/?blockquote\b/u, "blockquote"],
      [/<\/?strike\b/u, "strike"],
      [/<\/?s>/u, "s (strikethrough)"],
      [/<\/?del\b/u, "del"],
      [/<\/?ins\b/u, "ins"],
      [/<\/?u>/u, "u (underline)"],
      [/<\/?th[\s>]/u, "th (table header cell)"],
      [/<\/?em\b/u, "em"],
      [/<\/?strong\b/u, "strong"],
    ];
    for (const [pattern, label] of bannedPatterns) {
      expect(out, `output should not contain ${label}`).not.toMatch(pattern);
    }
  });
});

describe("inline HTML safety", () => {
  it("escapes inline HTML so it cannot inject MessageML tags", () => {
    const out = markdownToMessageMlBody("hello <script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("preserves a literal Symphony MessageML mention tag as text (will be re-emitted by AI hint instead)", () => {
    // We escape it; the AI should write mention tags only via the prompt-hint path,
    // not embedded in arbitrary Markdown text. Defense-in-depth.
    const out = markdownToMessageMlBody('hi <mention email="a@b.com"/>');
    expect(out).toContain("&lt;mention");
  });
});

describe("Japanese", () => {
  it("Japanese plain text passes through unchanged", () => {
    expect(markdownToMessageMlBody("こんにちは、世界")).toBe("<p>こんにちは、世界</p>");
  });
  it("Japanese heading + list", () => {
    const md = "## 結論\n- 一つ目\n- 二つ目";
    const out = markdownToMessageMlBody(md);
    expect(out).toContain("<h2>結論</h2>");
    // Loose list items get wrapped in <p>; tight lists don't.
    expect(out).toContain("一つ目");
    expect(out).toContain("二つ目");
    expect(out).toMatch(/<ul>.*<li>.*<\/li>.*<li>.*<\/li>.*<\/ul>/s);
  });
});

describe("integration: realistic AI output", () => {
  it("converts a multi-element message correctly", () => {
    const md = [
      "## 結論",
      "",
      "**ファイルを確認してください**:",
      "",
      "- `src/foo.ts`",
      "- `src/bar.ts`",
      "",
      "詳細は [ドキュメント](https://example.com/docs) を参照。",
      "",
      "```ts",
      "const x: number = 1;",
      "```",
    ].join("\n");
    const out = markdownToMessageMl(md);
    expect(out).toContain("<messageML>");
    expect(out).toContain("<h2>結論</h2>");
    expect(out).toContain("<b>ファイルを確認してください</b>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<code>src/foo.ts</code>");
    expect(out).toContain('<a href="https://example.com/docs">ドキュメント</a>');
    expect(out).toContain("<pre>const x: number = 1;</pre>");
    expect(out).toContain("</messageML>");
  });
});
