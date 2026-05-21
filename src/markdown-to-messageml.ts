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
import { Marked, type RendererObject, type Tokens } from "marked";
import { escapeXml } from "./messageml.js";

function escapeAttr(value: string): string {
  return escapeXml(value);
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
  code({ text }: Tokens.Code) {
    // language attr exists from Agent 20.14+ but is rarely needed; we drop it
    return `<pre>${escapeXml(text)}</pre>`;
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
  link({ href, tokens, title }: Tokens.Link) {
    const inner = this.parser.parseInline(tokens);
    const safeHref = escapeAttr(href ?? "");
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
    return `<a href="${safeHref}"${titleAttr}>${inner}</a>`;
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
      // GFM task-list items: prepend a plain-text marker since Symphony
      // <checkbox> is a form element, not a display element.
      const taskPrefix = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
      body += `<li>${taskPrefix}${this.parser.parse(item.tokens)}</li>`;
    }
    return `<${tag}${startAttr}>${body}</${tag}>`;
  },
  listitem(item: Tokens.ListItem) {
    // Usually unreachable (the `list` renderer composes items inline) but
    // kept as a safety net mirroring the same task-marker logic.
    const taskPrefix = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
    return `<li>${taskPrefix}${this.parser.parse(item.tokens)}</li>`;
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
