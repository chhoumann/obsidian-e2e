import { describe, expect, test } from "vite-plus/test";

import {
  createNoteDocument,
  parseNoteDocument,
  stringifyNoteDocument,
} from "../../src/note/document";

describe("note document model", () => {
  test("parses notes without frontmatter", () => {
    const document = parseNoteDocument("# Heading\nbody\n");

    expect(document).toEqual({
      body: "# Heading\nbody\n",
      frontmatter: null,
      raw: "# Heading\nbody\n",
    });
  });

  test("parses frontmatter and body with normalized line endings", () => {
    const document = parseNoteDocument("---\r\ntags:\r\n  - one\r\n---\r\nline 1\r\nline 2\r\n");

    expect(document).toEqual({
      body: "line 1\nline 2\n",
      frontmatter: {
        tags: ["one"],
      },
      raw: "---\ntags:\n  - one\n---\nline 1\nline 2\n",
    });
  });

  test("preserves empty-body documents with frontmatter", () => {
    const raw = stringifyNoteDocument({
      body: "",
      frontmatter: {
        done: false,
      },
    });

    expect(raw).toBe("---\ndone: false\n---\n");
    expect(parseNoteDocument(raw)).toEqual({
      body: "",
      frontmatter: {
        done: false,
      },
      raw: "---\ndone: false\n---\n",
    });
  });

  test("serializes no-frontmatter documents to body-only output", () => {
    const raw = stringifyNoteDocument({
      body: "alpha\r\nbeta\r\n",
      frontmatter: null,
    });

    expect(raw).toBe("alpha\nbeta\n");
  });

  test("creates deterministic note documents from frontmatter and body", () => {
    const document = createNoteDocument({
      body: "Content",
      frontmatter: {
        aliases: ["Doc"],
        published: true,
      },
    });

    expect(document.frontmatter).toEqual({
      aliases: ["Doc"],
      published: true,
    });
    expect(document.body).toBe("Content");
    expect(document.raw).toBe("---\naliases:\n  - Doc\npublished: true\n---\nContent");
  });

  test("throws when frontmatter parses to a non-object", () => {
    expect(() => parseNoteDocument("---\n- one\n---\nbody")).toThrow(
      "Expected note frontmatter to be a YAML mapping object.",
    );
  });
});
