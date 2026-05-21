import { describe, expect, it } from "vitest";
import { textWithSymphonyFormToMessageMl } from "../src/messageml.js";

function fence(json: object | string): string {
  const body = typeof json === "string" ? json : JSON.stringify(json);
  return `\`\`\`symphony-form\n${body}\n\`\`\``;
}

describe("textWithSymphonyFormToMessageMl", () => {
  it("falls back to markdownToMessageMl when there is no symphony-form block", () => {
    // Plain text now flows through the Markdown converter (which wraps it in <p>)
    expect(textWithSymphonyFormToMessageMl("hello world")).toBe(
      "<messageML><p>hello world</p></messageML>",
    );
  });

  it("converts Markdown in non-form text", () => {
    // Verifies the wiring to markdownToMessageMl — full Markdown coverage is
    // exercised in test/markdown-to-messageml.test.ts.
    const out = textWithSymphonyFormToMessageMl("## title\n\n**bold**");
    expect(out).toContain("<h2>title</h2>");
    expect(out).toContain("<b>bold</b>");
  });

  it("renders a buttons-type form with one <button> per choice", () => {
    const text = fence({
      form_id: "vote",
      question: "Yes or no?",
      ui_type: "buttons",
      choices: [
        { id: "y", label: "Yes", class: "primary" },
        { id: "n", label: "No", class: "secondary" },
      ],
    });
    const ml = textWithSymphonyFormToMessageMl(text);
    expect(ml).toContain('<form id="vote">');
    expect(ml).toContain("<p><b>Yes or no?</b></p>");
    expect(ml).toContain('<button name="y" type="action" class="primary">Yes</button>');
    expect(ml).toContain('<button name="n" type="action" class="secondary">No</button>');
  });

  it("renders a radio-type form with one <radio> per choice plus a submit button", () => {
    const text = fence({
      form_id: "color",
      ui_type: "radio",
      choices: [
        { id: "r", label: "Red" },
        { id: "b", label: "Blue" },
      ],
    });
    const ml = textWithSymphonyFormToMessageMl(text);
    expect(ml).toContain('<radio name="selected_option" value="r">Red</radio>');
    expect(ml).toContain('<radio name="selected_option" value="b">Blue</radio>');
    expect(ml).toContain('<button name="submit"');
  });

  it("renders a select-type form with <option> entries inside a <select>", () => {
    const text = fence({
      form_id: "size",
      ui_type: "select",
      choices: [
        { id: "s", label: "Small" },
        { id: "m", label: "Medium" },
      ],
    });
    const ml = textWithSymphonyFormToMessageMl(text);
    expect(ml).toContain('<select name="selected_option"');
    expect(ml).toContain('<option value="s">Small</option>');
    expect(ml).toContain('<option value="m">Medium</option>');
    expect(ml).toContain('<button name="submit"');
  });

  it("falls back to plain MessageML when the form JSON is malformed", () => {
    const text = "see below:\n```symphony-form\n{ not valid }\n```";
    const ml = textWithSymphonyFormToMessageMl(text);
    expect(ml).toContain("<messageML>");
    expect(ml).not.toContain("<form");
  });

  it("escapes XML special characters in labels and ids to prevent injection", () => {
    const text = fence({
      form_id: 'evil"id',
      question: "Pick <one>",
      ui_type: "buttons",
      choices: [{ id: "x", label: "Choice <a>" }],
    });
    const ml = textWithSymphonyFormToMessageMl(text);
    expect(ml).toContain("evil&quot;id");
    expect(ml).toContain("Pick &lt;one&gt;");
    expect(ml).toContain("Choice &lt;a&gt;");
  });

  it("keeps leading user-facing text alongside the form (separated by <br/>)", () => {
    const text = `Here are your options:\n${fence({
      form_id: "f",
      ui_type: "buttons",
      choices: [{ id: "a", label: "A" }],
    })}`;
    const ml = textWithSymphonyFormToMessageMl(text);
    expect(ml).toContain("Here are your options:");
    expect(ml).toContain("<br/>");
    expect(ml).toContain("<form");
  });

  it("uses a default form_id when omitted", () => {
    const text = fence({ ui_type: "buttons", choices: [{ id: "a", label: "A" }] });
    expect(textWithSymphonyFormToMessageMl(text)).toContain('<form id="default_form">');
  });
});
