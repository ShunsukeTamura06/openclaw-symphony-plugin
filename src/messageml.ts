import type { SymphonyMessage } from "./symphony/types.js";

export type MentionDirective =
  | { kind: "user"; userId: number }
  | { kind: "email"; email: string };

export type ToMessageMlInput = {
  text: string;
  mentions?: MentionDirective[];
  emojis?: string[];
};

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(input: string): string {
  return input.replace(/[&<>"']/gu, (c) => XML_ESCAPES[c] ?? c);
}

const XML_UNESCAPES: Array<[RegExp, string]> = [
  [/&lt;/gu, "<"],
  [/&gt;/gu, ">"],
  [/&quot;/gu, '"'],
  [/&apos;/gu, "'"],
  [/&#(\d+);/gu, ""],
  [/&amp;/gu, "&"],
];

export function unescapeXml(input: string): string {
  let out = input;
  for (const [pattern, replacement] of XML_UNESCAPES) {
    if (pattern.source === "&#(\\d+);") {
      out = out.replace(/&#(\d+);/gu, (_m, code: string) => String.fromCodePoint(Number(code)));
      continue;
    }
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function plainToMessageMl(input: ToMessageMlInput): string {
  const parts: string[] = [];
  let text = input.text ?? "";

  if (input.mentions && input.mentions.length > 0) {
    const mentionTags = input.mentions.map(renderMention).join(" ");
    parts.push(`${mentionTags} `);
  }

  text = escapeXml(text).replace(/\r?\n/gu, "<br/>");

  if (input.emojis && input.emojis.length > 0) {
    const emojiTags = input.emojis.map((shortcode) => `<emoji shortcode="${escapeXml(shortcode)}"/>`).join("");
    text = `${text} ${emojiTags}`;
  }

  parts.push(text);
  return `<messageML>${parts.join("")}</messageML>`;
}

function renderMention(m: MentionDirective): string {
  if (m.kind === "user") {
    return `<mention uid="${m.userId}"/>`;
  }
  return `<mention email="${escapeXml(m.email)}"/>`;
}

export type ParsedMessageMl = {
  text: string;
  mentions: Array<{ userId?: number; email?: string }>;
  emojis: string[];
};

export function messageMlToPlain(messageMl: string): ParsedMessageMl {
  const mentions: ParsedMessageMl["mentions"] = [];
  const emojis: string[] = [];

  let processed = messageMl ?? "";

  processed = processed.replace(
    /<mention\s+([^>]*)\/?>(?:<\/mention>)?/giu,
    (_match, attrs: string) => {
      const uidMatch = /uid\s*=\s*"([^"]+)"/iu.exec(attrs);
      const emailMatch = /email\s*=\s*"([^"]+)"/iu.exec(attrs);
      if (uidMatch?.[1]) {
        const uid = Number(uidMatch[1]);
        if (Number.isFinite(uid)) {
          mentions.push({ userId: uid });
        }
        return `@${uidMatch[1]} `;
      }
      if (emailMatch?.[1]) {
        mentions.push({ email: emailMatch[1] });
        return `@${emailMatch[1]} `;
      }
      return "";
    },
  );

  processed = processed.replace(
    /<emoji\s+([^>]*)\/?>(?:<\/emoji>)?/giu,
    (_match, attrs: string) => {
      const shortcodeMatch = /shortcode\s*=\s*"([^"]+)"/iu.exec(attrs);
      if (shortcodeMatch?.[1]) {
        emojis.push(shortcodeMatch[1]);
        return `:${shortcodeMatch[1]}:`;
      }
      return "";
    },
  );

  processed = processed
    .replace(/<br\s*\/?>(?!<\/br>)/giu, "\n")
    .replace(/<\/p>/giu, "\n")
    .replace(/<\/li>/giu, "\n");

  processed = processed.replace(/<[^>]+>/gu, "");

  processed = unescapeXml(processed).replace(/ /gu, " ").trim();

  return { text: processed, mentions, emojis };
}

export function extractPlainTextFromInbound(message: SymphonyMessage): string {
  return messageMlToPlain(message.message ?? "").text;
}
