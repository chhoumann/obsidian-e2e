import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type NoteFrontmatter = Record<string, unknown>;

export interface NoteDocument {
  body: string;
  frontmatter: NoteFrontmatter | null;
  raw: string;
}

export interface NoteDocumentInput {
  body?: string;
  frontmatter?: NoteFrontmatter | null;
}

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

export function stringifyNoteDocument(input: NoteDocumentInput): string {
  const normalizedBody = normalizeLineEndings(input.body ?? "");
  if (!input.frontmatter) {
    return normalizedBody;
  }

  const frontmatterYaml = stringifyYaml(input.frontmatter).trimEnd();
  const frontmatterSection = frontmatterYaml ? `---\n${frontmatterYaml}\n---\n` : "---\n---\n";
  return `${frontmatterSection}${normalizedBody}`;
}

export function createNoteDocument(input: NoteDocumentInput): NoteDocument {
  const raw = stringifyNoteDocument(input);
  return parseNoteDocument(raw);
}

interface ParsedFrontmatterBlock {
  body: string;
  frontmatterRaw: string;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
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
