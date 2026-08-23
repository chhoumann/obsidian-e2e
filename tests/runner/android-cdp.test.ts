import { describe, expect, test } from "vite-plus/test";

import { CdpClient, type CdpSocket } from "../../src/runner/android/cdp";

/**
 * A fake devtools endpoint: answers /json with the given targets and replies
 * to each Runtime.evaluate with the scripted CDP response.
 */
function fakeEndpoint(respond: (expression: string) => Record<string, unknown>) {
  const sent: string[] = [];
  let listener: (data: string) => void = () => {};
  const socket: CdpSocket = {
    send: (data) => {
      sent.push(data);
      const message = JSON.parse(data) as { id: number; params: { expression: string } };
      // Reply asynchronously like a real socket would.
      queueMicrotask(() =>
        listener(JSON.stringify({ id: message.id, result: respond(message.params.expression) })),
      );
    },
    close: () => {},
    onMessage: (l) => {
      listener = l;
    },
  };
  return {
    sent,
    deps: {
      fetchJson: () =>
        Promise.resolve([
          { type: "service_worker" },
          { type: "page", webSocketDebuggerUrl: "ws://fake" },
        ]),
      connect: () => Promise.resolve(socket),
    },
  };
}

describe("CdpClient", () => {
  test("connects to the first page target and evaluates by value", async () => {
    const endpoint = fakeEndpoint(() => ({ result: { value: "qa" } }));
    const client = await CdpClient.connect(9222, endpoint.deps);
    const result = await client.evaluate("app.vault.getName()");
    expect(result).toEqual({ value: "qa" });
    const sent = JSON.parse(endpoint.sent[0] ?? "{}") as { method: string; params: object };
    expect(sent.method).toBe("Runtime.evaluate");
    expect(sent.params).toMatchObject({ awaitPromise: true, returnByValue: true });
  });

  test("surfaces an in-page exception as a result, not a throw", async () => {
    const endpoint = fakeEndpoint(() => ({
      exceptionDetails: { exception: { description: "ReferenceError: nope" } },
    }));
    const client = await CdpClient.connect(9222, endpoint.deps);
    const result = await client.evaluate("nope");
    expect(result.exception).toBe("ReferenceError: nope");
  });

  test("fails clearly when no page target is debuggable", async () => {
    await expect(
      CdpClient.connect(9222, {
        fetchJson: () => Promise.resolve([{ type: "service_worker" }]),
        connect: () => Promise.reject(new Error("unused")),
      }),
    ).rejects.toThrow(/No debuggable page target on CDP port 9222/);
  });
});

describe("CdpClient protocol errors", () => {
  test("a top-level CDP error surfaces as an exception, not a successful undefined", async () => {
    const sent: string[] = [];
    let listener: (data: string) => void = () => {};
    const socket: CdpSocket = {
      send: (data) => {
        sent.push(data);
        const message = JSON.parse(data) as { id: number };
        queueMicrotask(() =>
          listener(
            JSON.stringify({
              id: message.id,
              error: { message: "Execution context was destroyed." },
            }),
          ),
        );
      },
      close: () => {},
      onMessage: (l) => {
        listener = l;
      },
    };
    const client = await CdpClient.connect(9222, {
      fetchJson: () => Promise.resolve([{ type: "page", webSocketDebuggerUrl: "ws://fake" }]),
      connect: () => Promise.resolve(socket),
    });
    const result = await client.evaluate("1");
    expect(result.exception).toBe("CDP protocol error: Execution context was destroyed.");
    expect(result.value).toBeUndefined();
  });
});
