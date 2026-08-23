/**
 * Minimal Chrome DevTools Protocol client for Obsidian mobile's webview. The
 * app ships with webview debugging enabled, so after `adb forward` the page
 * target is reachable over plain HTTP + WebSocket - this is the runner's whole
 * remote-control surface on Android (there is no obsidian CLI socket there).
 *
 * Uses the Node >= 22 global `WebSocket`; no dependency is added for it.
 */

export interface CdpTargetInfo {
  type: string;
  webSocketDebuggerUrl?: string;
}

/**
 * The network boundary, injectable for tests: `fetchJson` lists targets and
 * `connect` opens the page socket. Production uses global fetch/WebSocket.
 */
export interface CdpDependencies {
  fetchJson?: (url: string) => Promise<unknown>;
  connect?: (url: string) => Promise<CdpSocket>;
}

/** The subset of a WebSocket the client needs, so a fake can stand in. */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  onMessage(listener: (data: string) => void): void;
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

const defaultConnect = async (url: string): Promise<CdpSocket> => {
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
  });
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onMessage: (listener) =>
      ws.addEventListener("message", (event) => listener(String((event as MessageEvent).data))),
  };
};

/**
 * A connected CDP session against the app's page target. One session per
 * runner invocation; `close` when done so the process can exit.
 */
export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();

  private constructor(private readonly socket: CdpSocket) {
    socket.onMessage((data) => {
      const message = JSON.parse(data) as Record<string, unknown>;
      const id = typeof message.id === "number" ? message.id : undefined;
      if (id !== undefined && this.pending.has(id)) {
        this.pending.get(id)?.(message);
        this.pending.delete(id);
      }
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
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) {
      throw new Error(
        `No debuggable page target on CDP port ${cdpPort}. Is the Obsidian app running ` +
          `and the port forwarded to its webview devtools socket?`,
      );
    }
    return new CdpClient(await connect(page.webSocketDebuggerUrl));
  }

  private send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
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

  close(): void {
    this.socket.close();
  }
}
