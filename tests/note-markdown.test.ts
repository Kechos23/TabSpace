import { expect, it } from "vitest";
import { markdown, type Doc } from "../packages/domain/model";
it("exports the Notes toolbar's quote, ordered list and inline styles", () => {
  const paragraph = (text: string): Doc => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  });
  expect(markdown({ type: "blockquote", content: [paragraph("Quoted")] })).toBe(
    "> Quoted\n\n",
  );
  expect(
    markdown({
      type: "orderedList",
      attrs: { start: 3 },
      content: [
        { type: "listItem", content: [paragraph("First")] },
        { type: "listItem", content: [paragraph("Second")] },
      ],
    }),
  ).toBe("3. First\n4. Second\n");
  expect(
    markdown({ type: "text", text: "Done", marks: [{ type: "strike" }] }),
  ).toBe("~~Done~~");
  expect(
    markdown({
      type: "text",
      text: "Underlined",
      marks: [{ type: "underline" }],
    }),
  ).toBe("<u>Underlined</u>");
});
