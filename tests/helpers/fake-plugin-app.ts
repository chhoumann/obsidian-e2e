import {
  ObsidianCommandDispatchError,
  ObsidianCommandError,
  ObsidianCommandTimeoutError,
} from "../../src/core/errors";
import type { CommandTransport } from "../../src/core/types";
import { createExecResult, frameEvalPayload } from "./create-exec-result";

export type CommandFault =
  | "connect-fail"
  | "lose-reply"
  | "lose-request"
  | "refuse"
  | "still-pending";

export interface FakePluginApp {
  readonly calls: string[];
  failNext(command: string, ...faults: CommandFault[]): void;
  isEnabled(): boolean;
  transport: CommandTransport;
}

/**
 * A transport faithful to Obsidian 1.13's community plugin CLI handlers: a
 * toggle that is already in effect, or a reload of a disabled plugin, is
 * answered with an `Error: ...` reply on a zero exit code.
 */
export function createFakePluginApp(options: {
  enabled?: boolean;
  pluginId: string;
  vaultRoot: string;
}): FakePluginApp {
  const { pluginId, vaultRoot } = options;
  let enabled = options.enabled ?? true;
  const calls: string[] = [];
  const faults = new Map<string, CommandFault[]>();

  function run(command: string, args: Record<string, string>): string {
    switch (command) {
      case "vault":
        return vaultRoot;
      case "plugin":
        return `id\t${pluginId}\nenabled\t${enabled}`;
      case "plugin:enable":
        if (enabled) return `Error: Plugin "${pluginId}" is already enabled.`;
        enabled = true;
        return `Enabled: ${pluginId}`;
      case "plugin:disable":
        if (!enabled) return `Error: Plugin "${pluginId}" is already disabled.`;
        enabled = false;
        return `Disabled: ${pluginId}`;
      case "plugin:reload":
        return enabled ? `Reloaded: ${pluginId}` : `Error: Plugin "${pluginId}" is not enabled.`;
      case "eval":
        return frameEvalPayload(args.code ?? "", JSON.stringify({ ok: true, value: enabled }));
      default:
        throw new Error(`Unhandled fake command: ${command}`);
    }
  }

  const transport: CommandTransport = async (request) => {
    const [, command = "", ...rest] = request.argv;
    const args = Object.fromEntries(
      rest
        .filter((entry) => entry.includes("="))
        .map((entry) => {
          const [key, ...value] = entry.split("=");
          return [key, value.join("=")];
        }),
    );
    const fault = faults.get(command)?.shift();
    const lost = () => new ObsidianCommandTimeoutError(request.bin, request.argv, 0);

    if (fault === "connect-fail") {
      calls.push(`${command} -> (exit 1)`);
      const result = { ...createExecResult(request.bin, request.argv, ""), exitCode: 1 };

      if (!request.allowNonZeroExit) {
        throw new ObsidianCommandError("Obsidian command failed with exit code 1", result);
      }

      return result;
    }

    if (fault === "lose-request") {
      calls.push(`${command} -> (request lost)`);
      throw lost();
    }

    if (fault === "still-pending") {
      calls.push(`${command} -> (still running)`);
      throw new ObsidianCommandDispatchError(
        "still running",
        "still-pending",
        "nonce",
        request.argv,
      );
    }

    const reply =
      fault === "refuse"
        ? `Error: Failed to ${command.replace("plugin:", "")}: ${pluginId}`
        : run(command, args);
    calls.push(`${command} -> ${reply.split("\n")[0]}`);

    if (fault === "lose-reply") {
      throw lost();
    }

    return createExecResult(request.bin, request.argv, `${reply}\n`);
  };

  return {
    calls,
    failNext(command, ...nextFaults) {
      faults.set(command, [...(faults.get(command) ?? []), ...nextFaults]);
    },
    isEnabled: () => enabled,
    transport,
  };
}
