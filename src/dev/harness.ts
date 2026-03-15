import type {
  DevConsoleMessage,
  DevDiagnostics,
  DevEvalErrorPayload,
  DevNoticeEvent,
  DevRuntimeError,
} from "../core/types";

const HARNESS_NAMESPACE = "__obsidianE2E";
const HARNESS_VERSION = 1;

type HarnessMethodName =
  | "diagnostics"
  | "eval"
  | "frontmatter"
  | "metadata"
  | "activeFilePath"
  | "editorText"
  | "pluginLoaded"
  | "resetDiagnostics";

interface HarnessEnvelopeSuccess {
  ok: true;
  value: unknown;
}

interface HarnessEnvelopeError {
  error: DevEvalErrorPayload;
  ok: false;
}

type HarnessEnvelope = HarnessEnvelopeError | HarnessEnvelopeSuccess;

export function buildHarnessCallCode(method: HarnessMethodName, ...args: unknown[]): string {
  return `(() => {
    const __obsidianE2EMethod = ${JSON.stringify(method)};
    const __obsidianE2EArgs = ${JSON.stringify(args)};
    const __obsidianE2ENamespace = ${JSON.stringify(HARNESS_NAMESPACE)};
    const __obsidianE2EVersion = ${HARNESS_VERSION};
    const __obsidianE2EMaxEntries = 100;

    const __obsidianE2EPush = (entries, value) => {
      entries.push(value);
      if (entries.length > __obsidianE2EMaxEntries) {
        entries.splice(0, entries.length - __obsidianE2EMaxEntries);
      }
    };

    const __obsidianE2EFormat = (value) => {
      if (typeof value === "string") {
        return value;
      }

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const __obsidianE2ESerialize = (value, path = "$") => {
      if (value === null) {
        return null;
      }

      if (value === undefined) {
        return { __obsidianE2EType: "undefined" };
      }

      const valueType = typeof value;

      if (valueType === "string" || valueType === "boolean") {
        return value;
      }

      if (valueType === "number") {
        if (!Number.isFinite(value)) {
          throw new Error(\`Cannot serialize non-finite number at \${path}.\`);
        }

        return value;
      }

      if (valueType === "bigint" || valueType === "function" || valueType === "symbol") {
        throw new Error(\`Cannot serialize \${valueType} at \${path}.\`);
      }

      if (Array.isArray(value)) {
        return value.map((item, index) => __obsidianE2ESerialize(item, \`\${path}[\${index}]\`));
      }

      const prototype = Object.getPrototypeOf(value);

      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(\`Cannot serialize non-plain object at \${path}.\`);
      }

      const next = {};

      for (const [key, entry] of Object.entries(value)) {
        next[key] = __obsidianE2ESerialize(entry, \`\${path}.\${key}\`);
      }

      return next;
    };

    const __obsidianE2EClone = (value) => JSON.parse(JSON.stringify(__obsidianE2ESerialize(value)));

    const __obsidianE2ECreateHarness = () => {
      const state = {
        consoleMessages: [],
        notices: [],
        runtimeErrors: [],
      };

      const pushConsoleMessage = (level, args) => {
        __obsidianE2EPush(state.consoleMessages, {
          args: args.map((entry) => {
            try {
              return __obsidianE2EClone(entry);
            } catch {
              return __obsidianE2EFormat(entry);
            }
          }),
          at: Date.now(),
          level,
          text: args.map(__obsidianE2EFormat).join(" "),
        });
      };

      const pushRuntimeError = (source, errorLike) => {
        const message =
          errorLike && typeof errorLike === "object" && "message" in errorLike
            ? String(errorLike.message)
            : String(errorLike);
        const stack =
          errorLike && typeof errorLike === "object" && "stack" in errorLike
            ? String(errorLike.stack)
            : undefined;

        __obsidianE2EPush(state.runtimeErrors, {
          at: Date.now(),
          message,
          source,
          stack,
        });
      };

      const installConsolePatch = (root) => {
        if (root.__obsidianE2EConsolePatched) {
          return;
        }

        for (const level of ["debug", "error", "info", "log", "warn"]) {
          const original = root.console?.[level];

          if (typeof original !== "function") {
            continue;
          }

          root.console[level] = (...args) => {
            pushConsoleMessage(level, args);
            return original.apply(root.console, args);
          };
        }

        root.__obsidianE2EConsolePatched = true;
      };

      const installRuntimePatch = (root) => {
        if (root.__obsidianE2ERuntimePatched || typeof root.addEventListener !== "function") {
          return;
        }

        root.addEventListener("error", (event) => {
          pushRuntimeError("error", event?.error ?? event?.message ?? "Unknown error");
        });
        root.addEventListener("unhandledrejection", (event) => {
          pushRuntimeError("unhandledrejection", event?.reason ?? "Unhandled rejection");
        });

        root.__obsidianE2ERuntimePatched = true;
      };

      const installNoticePatch = (root) => {
        if (root.__obsidianE2ENoticePatched || typeof root.Notice !== "function") {
          return;
        }

        const OriginalNotice = root.Notice;
        root.Notice = new Proxy(OriginalNotice, {
          construct(target, ctorArgs, newTarget) {
            __obsidianE2EPush(state.notices, {
              at: Date.now(),
              message: __obsidianE2EFormat(ctorArgs[0] ?? ""),
              timeout:
                typeof ctorArgs[1] === "number" && Number.isFinite(ctorArgs[1])
                  ? ctorArgs[1]
                  : undefined,
            });

            return Reflect.construct(target, ctorArgs, newTarget);
          },
        });
        root.__obsidianE2ENoticePatched = true;
      };

      const ensureInstalled = () => {
        const root = globalThis;
        installConsolePatch(root);
        installRuntimePatch(root);
        installNoticePatch(root);
      };

      const getFileCache = (vaultPath) => {
        const file = app?.vault?.getAbstractFileByPath?.(vaultPath);
        if (!file) {
          return null;
        }

        return app?.metadataCache?.getFileCache?.(file) ?? null;
      };

      return {
        diagnostics() {
          ensureInstalled();
          return {
            consoleMessages: state.consoleMessages,
            notices: state.notices,
            runtimeErrors: state.runtimeErrors,
          };
        },
        eval(code) {
          ensureInstalled();
          return (0, eval)(code);
        },
        frontmatter(vaultPath) {
          ensureInstalled();
          return getFileCache(vaultPath)?.frontmatter ?? null;
        },
        metadata(vaultPath) {
          ensureInstalled();
          return getFileCache(vaultPath);
        },
        pluginLoaded(pluginId) {
          ensureInstalled();
          const plugins = app?.plugins;
          return Boolean(
            plugins?.enabledPlugins?.has?.(pluginId) &&
              plugins?.plugins?.[pluginId],
          );
        },
        activeFilePath() {
          ensureInstalled();
          return app?.workspace?.getActiveFile?.()?.path ?? null;
        },
        editorText() {
          ensureInstalled();
          return app?.workspace?.activeLeaf?.view?.editor?.getValue?.() ?? null;
        },
        resetDiagnostics() {
          state.consoleMessages.splice(0);
          state.notices.splice(0);
          state.runtimeErrors.splice(0);
          ensureInstalled();
          return true;
        },
      };
    };

    const root = globalThis;
    const current = root[__obsidianE2ENamespace];
    const harness =
      current && current.version === __obsidianE2EVersion
        ? current
        : (root[__obsidianE2ENamespace] = {
            api: __obsidianE2ECreateHarness(),
            version: __obsidianE2EVersion,
          });

    try {
      const result = harness.api[__obsidianE2EMethod](...__obsidianE2EArgs);
      return JSON.stringify({
        ok: true,
        value: __obsidianE2ESerialize(result),
      });
    } catch (error) {
      return JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : "Error",
          stack: error instanceof Error ? error.stack : undefined,
        },
        ok: false,
      });
    }
  })()`;
}

export function parseHarnessEnvelope<T>(raw: string): T {
  const envelope = JSON.parse(raw.startsWith("=> ") ? raw.slice(3) : raw) as HarnessEnvelope;

  if (!envelope.ok) {
    throw envelope.error;
  }

  return decodeHarnessValue(envelope.value) as T;
}

function decodeHarnessValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => decodeHarnessValue(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if ("__obsidianE2EType" in value && value.__obsidianE2EType === "undefined") {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decodeHarnessValue(entry)]),
  );
}

export function createDevDiagnostics(value: DevDiagnostics | null | undefined): DevDiagnostics {
  return {
    consoleMessages: [...(value?.consoleMessages ?? [])] as DevConsoleMessage[],
    notices: [...(value?.notices ?? [])] as DevNoticeEvent[],
    runtimeErrors: [...(value?.runtimeErrors ?? [])] as DevRuntimeError[],
  };
}
