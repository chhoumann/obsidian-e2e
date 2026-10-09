import { ObsidianCommandTimeoutError } from "../../src/core/errors";
import type { CommandTransport } from "../../src/core/types";
import { createExecResult, frameEvalPayload } from "./create-exec-result";

/**
 * `lose-request`: the command never reaches Obsidian. `lose-reply`: Obsidian
 * runs it, then the reply is lost. Both surface as a transport timeout.
 */
export type CommandFault = "lose-reply" | "lose-request";

export interface FakePluginApp {
  readonly calls: string[];
  failNext(command: string, ...faults: CommandFault[]): void;
  isEnabled(): boolean;
  setEnabled(value: boolean): void;
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
        // Every framed eval the plugin handle sends is a live-state probe.
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

    if (fault === "lose-request") {
      throw lost();
    }

    const reply = run(command, args);
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
    setEnabled(value) {
      enabled = value;
    },
    transport,
  };
}
