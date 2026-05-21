/**
 * Markdown -> MessageML converter.
 *
 * AI models habitually emit Markdown (`#`, `**bold**`, `- item`, code fences,
 * tables, etc.), but Symphony renders MessageML (XML) only. Without
 * conversion, raw Markdown syntax appears verbatim — or worse, Symphony
 * rejects the message entirely when an unsupported tag slips through.
 *
 * Per the official Symphony MessageML docs
 * (docs.developers.symphony.com/bots/messages/overview-of-messageml/...),
 * the supported tags are:
 *
 *   Block:   <p>, <div>, <h1>..<h6>, <hr/>, <pre>, <ul>, <ol>, <li>,
 *            <table>, <thead>, <tbody>, <tfoot>, <tr>, <td>
 *   Inline:  <b>, <i>, <span>, <a href="">, <code>, <br/>
 *   Symphony: <mention>, <emoji>, <hash>, <cash>, <tag>
 *   Forms:   <form>, <button>, <text-field>, <textarea>, <select>,
 *            <option>, <radio>, <checkbox>
 *
 * Tags Symphony does NOT support (and that this converter must NOT emit):
 *   <blockquote>, <strike>, <s>, <del>, <ins>, <u>, <em>, <strong>, <th>
 *
 * Markdown features without a MessageML equivalent (blockquote, strike,
 * task-list checkbox) degrade gracefully — content is preserved as plain
 * text, never wrapped in an unsupported tag.
 *
 * This is the *last* layer of defense; `agentPrompt.messageToolHints`
 * separately encourages the AI to emit MessageML natively for things the
 * converter cannot fully express (mentions, emoji, interactive forms).
 */
import { Marked, type RendererObject, type Token, type Tokens } from "marked";
import { escapeXml } from "./messageml.js";

function escapeAttr(value: string): string {
  return escapeXml(value);
}

/**
 * Languages Symphony's `<code language="...">` officially supports for
 * syntax highlighting (Agent 20.14+). Source: Symphony MessageML basic
 * format tags doc. Anything not in this set (or no language given)
 * collapses to `plaintext` so the message still ships without rejection
 * but renders monospace-only.
 */
const SYMPHONY_CODE_LANGUAGES = new Set([
  "c",
  "cpp",
  "csharp",
  "css",
  "html",
  "java",
  "js",
  "jsx",
  "json",
  "markdown",
  "php",
  "plaintext",
  "python",
  "r",
  "scala",
  "shell",
  "tsx",
  "typescript",
  "yaml",
]);

/**
 * Map common synonyms / Markdown info-string conventions to Symphony's
 * official identifier. Anything unknown returns `plaintext`.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  "c++": "cpp",
  "c#": "csharp",
  bash: "shell",
  sh: "shell",
  zsh: "shell",
  console: "shell",
  shellsession: "shell",
  javascript: "js",
  node: "js",
  jsx: "jsx",
  ts: "typescript",
  py: "python",
  yml: "yaml",
  md: "markdown",
  jsonc: "json",
  json5: "json",
};

function normalizeCodeLanguage(lang: string | undefined): string {
  if (!lang) return "plaintext";
  const lower = lang.trim().toLowerCase().split(/[\s,;]/u)[0] ?? "";
  if (!lower) return "plaintext";
  const mapped = LANGUAGE_ALIASES[lower] ?? lower;
  return SYMPHONY_CODE_LANGUAGES.has(mapped) ? mapped : "plaintext";
}

/**
 * Symphony's <a href="..."> doc lists "URL" without enumerating schemes.
 * We allow only http(s), mailto, and tel: in line with what the Symphony
 * client renders sensibly, and reject the common XSS / silent-reject
 * carriers (javascript:, data:, blob:, file:, vbscript:). Unknown schemes
 * are rejected too — safer to display the bare text than to risk Symphony
 * rejecting the entire message.
 */
function isAllowedHref(href: string | undefined): href is string {
  if (!href) return false;
  const trimmed = href.trim();
  if (!trimmed) return false;
  // Allow relative URLs (start with /, #, or ?). Most chat clients ignore
  // these but they aren't dangerous.
  if (/^[/#?]/u.test(trimmed)) return true;
  // Otherwise require an allowlisted scheme.
  return /^(?:https?:\/\/|mailto:|tel:)/iu.test(trimmed);
}

type MarkedParser = {
  parse: (tokens: Tokens.Generic[] | Token[]) => string;
  parseInline: (tokens: Token[] | Tokens.Generic[]) => string;
};

/**
 * Render a single list item to MessageML, never wrapping content in `<p>`.
 *
 * Why this matters: Symphony's MessageML doc explicitly lists what `<li>`
 * can contain ("inline and block content") but does NOT confirm `<p>` is
 * permitted there. Some pods reject the whole message. marked's default
 * behavior for "loose" lists wraps each text token in `<p>` — we must
 * route around that.
 *
 * Token shape (verified empirically against marked 15.x):
 *   - Tight item (no blank line):   item.loose=false, tokens=[Text]
 *   - Loose item w/ multi-para:     item.loose=true,  tokens=[Text, Space, Text, ...]
 *   - Nested list inside item:      item.loose=true,  tokens=[Text, Space, List]
 *   - Code block inside item:       item.loose=true,  tokens=[Text, Space, Code]
 *
 * Strategy: walk item.tokens. Render each `text` token as inline content
 * (no `<p>` wrapper). For loose items with multiple inline-text segments,
 * separate them with `<br/>`. For block-level children (list, code,
 * blockquote), call the regular block parser. Space tokens are dropped.
 */
function renderListItem(parser: MarkedParser, item: Tokens.ListItem): string {
  const taskPrefix = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
  let inner = "";
  let prevWasInlineText = false;
  for (const token of item.tokens) {
    const type = (token as { type: string }).type;
    if (type === "text") {
      if (item.loose && prevWasInlineText) {
        inner += "<br/>";
      }
      const text = token as Tokens.Text;
      if (text.tokens) {
        inner += parser.parseInline(text.tokens);
      } else {
        inner += escapeXml(text.text);
      }
      prevWasInlineText = true;
    } else if (type === "space") {
      // Source-level whitespace between tokens — discard. The <br/> insertion
      // between inline-text segments is handled above when the *next* inline
      // text fires.
      continue;
    } else if (type === "paragraph") {
      // Some markdown shapes (e.g., loose lists nested in blockquotes) do
      // produce paragraph tokens at list-item level. Treat them like text:
      // unwrap to inline, no <p>.
      if (item.loose && prevWasInlineText) {
        inner += "<br/>";
      }
      inner += parser.parseInline((token as Tokens.Paragraph).tokens);
      prevWasInlineText = true;
    } else {
      // Block-level child (list, code, hr, table, etc.) — render normally.
      inner += parser.parse([token as Tokens.Generic]);
      prevWasInlineText = false;
    }
  }
  return `<li>${taskPrefix}${inner}</li>`;
}

const renderer: RendererObject = {
  heading({ tokens, depth }: Tokens.Heading) {
    const inline = this.parser.parseInline(tokens);
    const clampedDepth = depth >= 1 && depth <= 6 ? depth : 6;
    return `<h${clampedDepth}>${inline}</h${clampedDepth}>`;
  },
  paragraph({ tokens }: Tokens.Paragraph) {
    return `<p>${this.parser.parseInline(tokens)}</p>`;
  },
  strong({ tokens }: Tokens.Strong) {
    return `<b>${this.parser.parseInline(tokens)}</b>`;
  },
  em({ tokens }: Tokens.Em) {
    return `<i>${this.parser.parseInline(tokens)}</i>`;
  },
  /**
   * Symphony has NO strikethrough tag (no <strike>, <s>, <del>, <u>).
   * Render the inner content as plain text so the words are preserved.
   */
  del({ tokens }: Tokens.Del) {
    return this.parser.parseInline(tokens);
  },
  codespan({ text }: Tokens.Codespan) {
    return `<code>${escapeXml(text)}</code>`;
  },
  code({ text, lang }: Tokens.Code) {
    // Symphony's canonical block code tag is <code language="..."> (Agent
    // 20.14+, which any modern pod runs). <pre> still works but gets no
    // syntax highlighting. We always emit <code language="..."> and fall
    // back to `plaintext` for unknown languages so the result is always a
    // valid block-code element.
    const language = normalizeCodeLanguage(lang);
    return `<code language="${language}">${escapeXml(text)}</code>`;
  },
  /**
   * Symphony has NO <blockquote>. Emit the inner content as-is. The visual
   * "quoted" cue is lost; this is the best degradation the format allows.
   */
  blockquote({ tokens }: Tokens.Blockquote) {
    return this.parser.parse(tokens);
  },
  hr() {
    return `<hr/>`;
  },
  br() {
    return `<br/>`;
  },
  link({ href, tokens }: Tokens.Link) {
    const inner = this.parser.parseInline(tokens);
    // Symphony's <a> spec lists only `href` and `class`. `title` is NOT
    // documented and may cause MessageML rejection — drop it.
    // Also validate the scheme: javascript: / data: / blob: are XSS vectors;
    // unknown schemes risk silent server-side rejection. When unsafe, emit
    // the visible text only (preserve content, drop the link).
    if (!isAllowedHref(href)) {
      return inner;
    }
    return `<a href="${escapeAttr(href)}">${inner}</a>`;
  },
  image({ text, title, href }: Tokens.Image) {
    // Symphony does not render inline Markdown-style images (`![alt](url)`).
    // Symphony's own <img> requires data: URIs with size constraints and is
    // rarely useful here. Fall back to alt text so the description is kept.
    const fallback = text || title || href || "";
    return escapeXml(fallback);
  },
  list({ ordered, items, start }: Tokens.List) {
    const tag = ordered ? "ol" : "ul";
    const startAttr =
      ordered && typeof start === "number" && start !== 1 ? ` start="${start}"` : "";
    let body = "";
    for (const item of items) {
      body += renderListItem(this.parser, item);
    }
    return `<${tag}${startAttr}>${body}</${tag}>`;
  },
  listitem(item: Tokens.ListItem) {
    // Usually unreachable (the `list` renderer composes items inline) but
    // kept as a safety net mirroring the same paragraph-flattening logic.
    return renderListItem(this.parser, item);
  },
  /**
   * Symphony does NOT support <th>. Even for thead cells we must emit <td>.
   * To preserve the visual header distinction we wrap thead cell content in
   * <b> so it renders bold; rendering of the thead row itself is up to the
   * Symphony client.
   */
  table({ header, rows }: Tokens.Table) {
    let head = "<thead><tr>";
    for (const cell of header) {
      head += `<td><b>${this.parser.parseInline(cell.tokens)}</b></td>`;
    }
    head += "</tr></thead>";
    let body = "<tbody>";
    for (const row of rows) {
      body += "<tr>";
      for (const cell of row) {
        body += `<td>${this.parser.parseInline(cell.tokens)}</td>`;
      }
      body += "</tr>";
    }
    body += "</tbody>";
    return `<table>${head}${body}</table>`;
  },
  html({ text }: Tokens.HTML | Tokens.Tag) {
    // Symphony only accepts a whitelisted set of MessageML tags. Arbitrary
    // inline HTML is escaped so it becomes visible plain text rather than
    // silently passing through and getting Symphony to reject the whole
    // message.
    return escapeXml(text);
  },
  checkbox({ checked }: Tokens.Checkbox) {
    // marked emits this for GFM task-list items inline; rendered as a plain
    // text marker. Note: the wrapper <li> path in `list` already inserts the
    // marker, so this normally returns empty to avoid duplicate prefixes.
    return checked ? "" : "";
  },
};

const markedInstance = new Marked({
  gfm: true,
  breaks: false,
  renderer,
});

/**
 * Sanity strip: if a rogue unsupported tag slips through (e.g. a future
 * marked release emits a new token type before we override it), remove it
 * so Symphony does not reject the whole message. Content is preserved;
 * only the offending tag is removed.
 */
const DISALLOWED_TAG_RE =
  /<\/?(?:blockquote|strike|s|del|ins|u|em|strong|th|sup|sub|small|big|dl|dt|dd|figure|figcaption|aside|nav|header|footer|main|section|article|details|summary|mark|abbr|cite|kbd|samp|var|time|address|input|iframe|script|style|form\s+action|label)(?:\s[^>]*)?\/?>/giu;

function stripDisallowedTags(html: string): string {
  return html.replace(DISALLOWED_TAG_RE, "");
}

/**
 * Convert Markdown text into a MessageML body fragment (no `<messageML>`
 * wrapper). Used when composing the body alongside other MessageML
 * (e.g. concatenating with a `<form>` for Symphony Elements).
 */
export function markdownToMessageMlBody(text: string): string {
  if (!text) {
    return "";
  }
  const rendered = markedInstance.parse(text, { async: false }) as string;
  return stripDisallowedTags(rendered).trim();
}

/**
 * Convert Markdown text into a complete `<messageML>...</messageML>`
 * payload ready to ship to `/agent/v4/stream/.../message/create`.
 */
export function markdownToMessageMl(text: string): string {
  return `<messageML>${markdownToMessageMlBody(text)}</messageML>`;
}
