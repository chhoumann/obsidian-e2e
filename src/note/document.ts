import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { NoteDocument, NoteFrontmatter, NoteInput } from "../core/types";

export function parseNoteDocument(raw: string): NoteDocument {
  const normalizedRaw = normalizeLineEndings(raw);
  const parsed = parseFrontmatterBlock(normalizedRaw);

  if (!parsed) {
    return {
      body: normalizedRaw,
      frontmatter: null,
      raw: normalizedRaw,
    };
  }

  const parsedFrontmatter = parseYaml(parsed.frontmatterRaw);

  if (
    parsedFrontmatter !== null &&
    (typeof parsedFrontmatter !== "object" || Array.isArray(parsedFrontmatter))
  ) {
    throw new Error("Expected note frontmatter to be a YAML mapping object.");
  }

  return {
    body: normalizeLineEndings(parsed.body),
    frontmatter: (parsedFrontmatter ?? {}) as NoteFrontmatter,
    raw: normalizedRaw,
  };
}

export function stringifyNoteDocument(input: NoteInput): string {
  const normalizedBody = normalizeLineEndings(input.body ?? "");

  if (!input.frontmatter) {
    return normalizedBody;
  }

  const frontmatterYaml = stringifyYaml(input.frontmatter).trimEnd();
  const frontmatterSection = frontmatterYaml ? `---\n${frontmatterYaml}\n---\n` : "---\n---\n";

  return `${frontmatterSection}${normalizedBody}`;
}

export function createNoteDocument(input: NoteInput): NoteDocument {
  const body = normalizeLineEndings(input.body ?? "");

  if (input.frontmatter === undefined || input.frontmatter === null) {
    return {
      body,
      frontmatter: null,
      raw: stringifyNoteDocument({ body }),
    };
  }

  const frontmatter = cloneFrontmatter(input.frontmatter);

  return {
    body,
    frontmatter,
    raw: stringifyNoteDocument({
      body,
      frontmatter,
    }),
  };
}

interface ParsedFrontmatterBlock {
  body: string;
  frontmatterRaw: string;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function cloneFrontmatter<TFrontmatter extends NoteFrontmatter>(
  frontmatter: TFrontmatter,
): TFrontmatter {
  return JSON.parse(JSON.stringify(frontmatter)) as TFrontmatter;
}

function parseFrontmatterBlock(raw: string): ParsedFrontmatterBlock | null {
  if (!raw.startsWith("---")) {
    return null;
  }

  const openingMatch = raw.match(/^---(?:\n|$)/u);

  if (!openingMatch) {
    return null;
  }

  const openLength = openingMatch[0].length;
  const closingMatcher = /(?:^|\n)(?:---|\.\.\.)(?:\n|$)/gu;
  closingMatcher.lastIndex = openLength;
  const closingMatch = closingMatcher.exec(raw);

  if (!closingMatch) {
    return null;
  }

  const closingStart = closingMatch.index + (closingMatch[0].startsWith("\n") ? 1 : 0);
  const closingLength = closingMatch[0].startsWith("\n")
    ? closingMatch[0].length - 1
    : closingMatch[0].length;
  const frontmatterRaw = raw.slice(openLength, closingStart);
  const bodyStart = closingStart + closingLength;

  return {
    body: raw.slice(bodyStart),
    frontmatterRaw: frontmatterRaw.trimEnd(),
  };
}
