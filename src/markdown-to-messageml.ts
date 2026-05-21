/**
 * Markdown -> MessageML converter.
 *
 * AI models habitually emit Markdown (`#`, `**bold**`, `- item`, code fences,
 * tables, etc.), but Symphony renders MessageML (XML) only. Without
 * conversion, raw Markdown syntax appears verbatim in Symphony.
 *
 * This module uses `marked` with a custom renderer that emits MessageML tags
 * directly. Mapping table:
 *
 *   #..######           -> <h1>..<h6>
 *   **bold**            -> <b>
 *   *italic* / _x_      -> <i>
 *   ~~strike~~          -> <strike>
 *   `inline`            -> <code>
 *   ```block```          -> <pre>
 *   - / 1. lists        -> <ul>/<ol> + <li>
 *   > quote             -> <blockquote>
 *   ---                 -> <hr/>
 *   [text](url)         -> <a href="url">text</a>
 *   ![alt](url)         -> alt text only (Symphony has no inline images)
 *   GFM tables          -> <table><thead><tr><th>...</th></tr></thead><tbody>...</tbody></table>
 *   inline HTML         -> escaped as text (Symphony forbids arbitrary HTML)
 *
 * The converter is the *last* layer of defense; the channel's
 * `agentPrompt.messageToolHints` separately encourages the AI to emit
 * MessageML natively for things the converter cannot fully express
 * (mentions, emoji, interactive forms).
 */
import { Marked, type RendererObject, type Tokens } from "marked";
import { escapeXml } from "./messageml.js";

function escapeAttr(value: string): string {
  return escapeXml(value);
}

/**
 * marked's default `text` renderer returns text that has already been
 * HTML-escaped by the lexer. HTML escaping is a strict subset of XML
 * escaping for text content (both convert `&`, `<`, `>`), so it stays safe
 * when embedded in MessageML.
 */
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
  del({ tokens }: Tokens.Del) {
    return `<strike>${this.parser.parseInline(tokens)}</strike>`;
  },
  codespan({ text }: Tokens.Codespan) {
    // `text` from a codespan token is the raw inline code, NOT pre-escaped.
    return `<code>${escapeXml(text)}</code>`;
  },
  code({ text }: Tokens.Code) {
    // Block code; language is dropped because MessageML <pre> has no lang attr.
    return `<pre>${escapeXml(text)}</pre>`;
  },
  blockquote({ tokens }: Tokens.Blockquote) {
    return `<blockquote>${this.parser.parse(tokens)}</blockquote>`;
  },
  hr() {
    return `<hr/>`;
  },
  br() {
    return `<br/>`;
  },
  link({ href, tokens, title }: Tokens.Link) {
    const inner = this.parser.parseInline(tokens);
    const safeHref = escapeAttr(href ?? "");
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
    return `<a href="${safeHref}"${titleAttr}>${inner}</a>`;
  },
  image({ text, title, href }: Tokens.Image) {
    // Symphony does not render inline Markdown images. Fall back to alt text
    // so the message at least carries the description.
    const fallback = text || title || href || "";
    return escapeXml(fallback);
  },
  list({ ordered, items, start }: Tokens.List) {
    const tag = ordered ? "ol" : "ul";
    const startAttr =
      ordered && typeof start === "number" && start !== 1 ? ` start="${start}"` : "";
    let body = "";
    for (const item of items) {
      body += `<li>${this.parser.parse(item.tokens)}</li>`;
    }
    return `<${tag}${startAttr}>${body}</${tag}>`;
  },
  listitem(item: Tokens.ListItem) {
    // Usually not reached because `list` renders items directly, but we
    // provide a fallback for safety.
    return `<li>${this.parser.parse(item.tokens)}</li>`;
  },
  table({ header, rows }: Tokens.Table) {
    let head = "<thead><tr>";
    for (const cell of header) {
      head += `<th>${this.parser.parseInline(cell.tokens)}</th>`;
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
    // inline HTML is dropped — escape it so it becomes visible plain text
    // rather than silently disappearing.
    return escapeXml(text);
  },
};

const markedInstance = new Marked({
  gfm: true,
  breaks: false,
  renderer,
});

/**
 * Convert Markdown text into a MessageML body fragment (no `<messageML>`
 * wrapper). Used when you want to compose the body with other MessageML
 * (e.g. concatenating with a `<form>` for Symphony Elements).
 */
export function markdownToMessageMlBody(text: string): string {
  if (!text) {
    return "";
  }
  const rendered = markedInstance.parse(text, { async: false }) as string;
  return rendered.trim();
}

/**
 * Convert Markdown text into a complete `<messageML>...</messageML>`
 * payload ready to ship to `/agent/v4/stream/.../message/create`.
 */
export function markdownToMessageMl(text: string): string {
  return `<messageML>${markdownToMessageMlBody(text)}</messageML>`;
}
