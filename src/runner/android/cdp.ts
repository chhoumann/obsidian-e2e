/**
 * Minimal Chrome DevTools Protocol client for Obsidian mobile's webview. The
 * app ships with webview debugging enabled, so after `adb forward` the page
 * target is reachable over plain HTTP + WebSocket - this is the runner's whole
 * remote-control surface on Android (there is no obsidian CLI socket there).
 * The desktop capture primitives (`obsidian-e2e/capture`) reuse the same client
 * against a desktop instance launched with `--remote-debugging-port`.
 *
 * Uses the Node >= 22 global `WebSocket`; no dependency is added for it.
 */

export interface CdpTargetInfo {
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

/**
 * The network boundary, injectable for tests: `fetchJson` lists targets and
 * `connect` opens the page socket. Production uses global fetch/WebSocket.
 */
export interface CdpDependencies {
  fetchJson?: (url: string) => Promise<unknown>;
  connect?: (url: string, signal?: AbortSignal) => Promise<CdpSocket>;
  /** Abort a pending connection (closes a half-open WebSocket handshake). */
  signal?: AbortSignal;
  /** Pick the page target; defaults to the first debuggable page. */
  selectTarget?: (targets: CdpTargetInfo[]) => CdpTargetInfo | undefined;
}

/** The subset of a WebSocket the client needs, so a fake can stand in. */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  onMessage(listener: (data: string) => void): void;
  /** Optional: lets pending calls fail fast instead of hanging when the socket drops. */
  onClose?(listener: () => void): void;
}

export interface CdpEvaluateResult {
  value: unknown;
  exception?: string;
}

const EVALUATE_TIMEOUT_MS = 120_000;

const defaultFetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url);
  return (await response.json()) as unknown;
};

const defaultConnect = async (url: string, signal?: AbortSignal): Promise<CdpSocket> => {
  if (typeof WebSocket === "undefined") {
    throw new Error(
      "The android runner needs the global WebSocket client (Node 22+). Upgrade Node to use it.",
    );
  }
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () =>
      reject(new Error(`Cannot connect to the webview devtools socket at ${url}.`));
    signal?.addEventListener(
      "abort",
      () => {
        ws.close();
        reject(new Error(`Connection to ${url} aborted.`));
      },
      { once: true },
    );
  });
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onMessage: (listener) =>
      ws.addEventListener("message", (event) => listener(String((event as MessageEvent).data))),
    onClose: (listener) => ws.addEventListener("close", () => listener()),
  };
};

/**
 * A connected CDP session against the app's page target. One session per
 * runner invocation; `close` when done so the process can exit.
 */
export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private closed = false;

  private constructor(private readonly socket: CdpSocket) {
    socket.onMessage((data) => {
      const message = JSON.parse(data) as Record<string, unknown>;
      const id = typeof message.id === "number" ? message.id : undefined;
      if (id !== undefined && this.pending.has(id)) {
        this.pending.get(id)?.(message);
        this.pending.delete(id);
        return;
      }
      if (typeof message.method === "string") {
        const params = (message.params ?? {}) as Record<string, unknown>;
        for (const listener of this.listeners.get(message.method) ?? []) listener(params);
      }
    });
    socket.onClose?.(() => {
      this.closed = true;
      for (const resolve of this.pending.values()) {
        resolve({ error: { message: "CDP socket closed" } });
      }
      this.pending.clear();
    });
  }

  /**
   * Connect to the first page target on the forwarded CDP port. The /json
   * endpoint only answers when the Host header is `localhost` (Chromium's
   * devtools HTTP server rejects other hosts), hence the literal hostname.
   */
  static async connect(cdpPort: number, deps: CdpDependencies = {}): Promise<CdpClient> {
    const fetchJson = deps.fetchJson ?? defaultFetchJson;
    const connect = deps.connect ?? defaultConnect;

    const targets = (await fetchJson(`http://localhost:${cdpPort}/json`)) as CdpTargetInfo[];
    const page = deps.selectTarget
      ? deps.selectTarget(targets)
      : targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl && deps.selectTarget) {
      throw new Error(`No matching page target on CDP port ${cdpPort}.`);
    }
    if (!page?.webSocketDebuggerUrl) {
      throw new Error(
        `No debuggable page target on CDP port ${cdpPort}. Is the Obsidian app running ` +
          `and the port forwarded to its webview devtools socket?`,
      );
    }
    return new CdpClient(await connect(page.webSocketDebuggerUrl, deps.signal));
  }

  private send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve({ error: { message: "CDP socket closed" } });
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate an expression in the page, awaiting promises and returning the
   * value by JSON. Exceptions come back as a result (not a throw) so callers
   * can surface them with context.
   */
  async evaluate(expression: string): Promise<CdpEvaluateResult> {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: EVALUATE_TIMEOUT_MS,
    });
    // A top-level protocol error (evaluation timeout, destroyed execution
    // context, ...) carries no `result` at all; without this it would read as
    // a successful `undefined` evaluation.
    const protocolError = response.error as { message?: string } | undefined;
    if (protocolError) {
      return {
        value: undefined,
        exception: `CDP protocol error: ${protocolError.message ?? "unknown"}`,
      };
    }
    const result = response.result as
      | {
          result?: { value?: unknown };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        }
      | undefined;
    if (result?.exceptionDetails) {
      const details = result.exceptionDetails;
      return {
        value: undefined,
        exception: details.exception?.description ?? details.text ?? "evaluation failed",
      };
    }
    return { value: result?.result?.value };
  }

  /** Send any CDP command; throws on a protocol error. The raw escape hatch. */
  async call(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.send(method, params);
    const protocolError = response.error as { message?: string } | undefined;
    if (protocolError) {
      throw new Error(`CDP ${method} failed: ${protocolError.message ?? "unknown error"}`);
    }
    return (response.result ?? {}) as Record<string, unknown>;
  }

  /** Subscribe to a CDP event (e.g. `Page.screencastFrame`); returns an unsubscribe. */
  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  /** Close the socket; pending calls fail immediately rather than waiting on it. */
  close(): void {
    this.closed = true;
    for (const resolve of this.pending.values()) {
      resolve({ error: { message: "CDP socket closed" } });
    }
    this.pending.clear();
    this.socket.close();
  }
}
