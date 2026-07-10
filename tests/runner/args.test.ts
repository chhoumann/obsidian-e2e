import { describe, expect, test } from "vite-plus/test";

import {
  createArgsParser,
  parseArgs,
  SHARED_BOOLEAN_OPTIONS,
  SHARED_VALUE_OPTIONS,
} from "../../src/runner/args";

const spec = {
  valueOptions: SHARED_VALUE_OPTIONS,
  booleanOptions: SHARED_BOOLEAN_OPTIONS,
};

describe("parseArgs", () => {
  test("maps value and boolean flags to their explicit keys", () => {
    const { options, rest } = parseArgs(
      ["--vault", "dev", "--profile-root", "/tmp/p", "--force", "--config", "cfg.mjs"],
      spec,
    );

    expect(options).toEqual({
      vault: "dev",
      profileRoot: "/tmp/p",
      force: true,
      config: "cfg.mjs",
    });
    expect(rest).toEqual([]);
  });

  test("parses --config as a value option", () => {
    const { options } = parseArgs(["--config", "/abs/obsidian-e2e.config.mjs"], spec);
    expect(options.config).toBe("/abs/obsidian-e2e.config.mjs");
  });

  test("throws on an unknown option", () => {
    expect(() => parseArgs(["--nope"], spec)).toThrow(/Unknown option: --nope/);
  });

  test("throws when a value option has no value", () => {
    expect(() => parseArgs(["--vault"], spec)).toThrow(/--vault requires a value\./);
  });

  test("throws when a value option is followed by another flag", () => {
    expect(() => parseArgs(["--vault", "--force"], spec)).toThrow(/--vault requires a value\./);
  });

  test("treats bare -- as a true end-of-options terminator", () => {
    const { options, rest } = parseArgs(["--vault", "dev", "--", "eval", "--force"], spec);
    expect(options).toEqual({ vault: "dev" });
    // Tokens after -- are forwarded verbatim, never re-parsed as flags.
    expect(rest).toEqual(["eval", "--force"]);
  });

  test("skips a leading package-manager -- before a boolean flag", () => {
    // `pnpm run <script> -- --print-env` forwards the literal `--` ahead of the
    // script args; a leading `--` before one of our flags must not swallow it.
    const { options, rest } = parseArgs(["--", "--print-env"], {
      valueOptions: SHARED_VALUE_OPTIONS,
      booleanOptions: { ...SHARED_BOOLEAN_OPTIONS, "--print-env": "printEnv" },
    });
    expect(options).toEqual({ printEnv: true });
    expect(rest).toEqual([]);
  });

  test("skips a leading package-manager -- before a value flag, then stops at the command", () => {
    const { options, rest } = parseArgs(["--", "--vault", "dev", "eval", "code=x"], spec);
    expect(options).toEqual({ vault: "dev" });
    expect(rest).toEqual(["eval", "code=x"]);
  });

  test("keeps a leading -- as a terminator when the forwarded command follows", () => {
    const { options, rest } = parseArgs(["--", "eval", "code=x"], spec);
    expect(options).toEqual({});
    expect(rest).toEqual(["eval", "code=x"]);
  });

  test("stops at the first non-option token and forwards the rest", () => {
    const { options, rest } = parseArgs(["--force", "quickadd:list", "--json"], spec);
    expect(options).toEqual({ force: true });
    expect(rest).toEqual(["quickadd:list", "--json"]);
  });

  test("createArgsParser binds the spec", () => {
    const parse = createArgsParser(spec);
    expect(parse(["--json"]).options).toEqual({ json: true });
  });
});
