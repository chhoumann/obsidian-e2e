import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { parseCaptureArgs, runCaptureCli } from "../../src/capture/cli";
import {
  captureLaunchCommand,
  prepareCaptureProfile,
  resolveCaptureProfile,
} from "../../src/capture/launch";
import {
  captureScreenshot,
  connectCapture,
  pngSize,
  prepareCapture,
  typeText,
} from "../../src/capture/page";
import { buildConcatList, encoderArgs, startRecording } from "../../src/capture/record";
import { CdpClient, type CdpSocket } from "../../src/runner/android/cdp";
import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";

const tempDirectories: string[] = [];
afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

/** A fake page: `respond(method, params)` scripts replies; `emit` pushes CDP events. */
async function fakeClient(
  respond: (method: string, params: Record<string, unknown>) => Record<string, unknown>,
) {
  let listener: (data: string) => void = () => {};
  let closeListener: () => void = () => {};
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const socket: CdpSocket = {
    send: (data) => {
      const message = JSON.parse(data) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      sent.push(message);
      queueMicrotask(() =>
        listener(JSON.stringify({ id: message.id, ...respond(message.method, message.params) })),
      );
    },
    close: () => {},
    onMessage: (l) => {
      listener = l;
    },
    onClose: (l) => {
      closeListener = l;
    },
  };
  const client = await CdpClient.connect(9333, {
    fetchJson: () => Promise.resolve([{ type: "page", webSocketDebuggerUrl: "ws://fake" }]),
    connect: () => Promise.resolve(socket),
  });
  return {
    client,
    sent,
    emit: (method: string, params: Record<string, unknown>) =>
      listener(JSON.stringify({ method, params })),
    drop: () => closeListener(),
  };
}

function pngHeader(width: number, height: number): string {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer.toString("base64");
}

const expr = (params: Record<string, unknown>) =>
  typeof params.expression === "string" ? params.expression : "";
const value = (v: unknown) => ({ result: { result: { value: v } } });

describe("capture args", () => {
  test("flags anywhere before --, positionals kept, numbers parsed", () => {
    const parsed = parseCaptureArgs(["out.webm", "--fps", "12", "--cursor", "--", "a.sh", "--x"], {
      numbers: ["fps"],
      booleans: ["cursor"],
    });
    expect(parsed).toEqual({
      flags: { fps: 12, cursor: true },
      positionals: ["out.webm"],
      command: ["a.sh", "--x"],
    });
  });

  test("rejects unknown flags and non-numeric numbers", () => {
    expect(() => parseCaptureArgs(["--nope"], {})).toThrow(/Unknown option: --nope/);
    expect(() => parseCaptureArgs(["--fps", "x"], { numbers: ["fps"] })).toThrow(/number/);
  });

  test("record without a command fails before touching CDP", async () => {
    await expect(runCaptureCli(["record", "out.webm"], { stdout: () => {} })).rejects.toThrow(
      /needs a command after --/,
    );
  });

  test("`--` escapes dash-leading positional text outside launch/record", async () => {
    // Usage validation passes (1 positional), then fails only on the missing CDP endpoint.
    await expect(
      runCaptureCli(["type", "--port", "1", "--timeout", "1", "--", "--foo"], {
        stdout: () => {},
      }),
    ).rejects.toThrow(/did not become ready/);
  });

  test("help and unknown subcommand", async () => {
    const out: string[] = [];
    expect(await runCaptureCli(["--help"], { stdout: (t) => out.push(t) })).toBe(0);
    expect(out.join("")).toContain("capture <command>");
    expect(await runCaptureCli(["bogus"], { stderr: () => {} })).toBe(1);
  });
});

describe("capture launch", () => {
  test("linux without DISPLAY wraps xvfb-run with CDP, DPR and a private profile", () => {
    const options = { vaultPath: "/v/Demo", platform: "linux" as const, env: {}, scale: 2 };
    const profile = resolveCaptureProfile(options);
    expect(profile.home).toBe("/tmp/obsidian-e2e-capture-9333/home");
    const command = captureLaunchCommand(options, profile);
    expect(command.file).toBe("xvfb-run");
    expect(command.args.slice(0, 4)).toEqual([
      "-a",
      "-s",
      "-screen 0 3840x3200x24",
      "/opt/Obsidian/obsidian",
    ]);
    expect(command.args).toContain("--remote-debugging-port=9333");
    expect(command.args).toContain("--force-device-scale-factor=2");
    expect(command.args).toContain(`--user-data-dir=${profile.home}/.config/obsidian`);
    expect(command.env.HOME).toBe(profile.home);
    expect(command.env.OBSIDIAN_E2E_CAPTURE_XVFB).toBe("1");
  });

  test("an existing DISPLAY or macOS runs the app directly", () => {
    const linux = { vaultPath: "/v/D", platform: "linux" as const, env: { DISPLAY: ":0" } };
    expect(captureLaunchCommand(linux, resolveCaptureProfile(linux)).file).toBe(
      "/opt/Obsidian/obsidian",
    );
    const mac = { vaultPath: "/v/D", platform: "darwin" as const, env: {}, cdpPort: 9444 };
    const command = captureLaunchCommand(mac, resolveCaptureProfile(mac));
    expect(command.file).toBe("/Applications/Obsidian.app/Contents/MacOS/Obsidian");
    expect(command.args).not.toContain("--no-sandbox");
    expect(command.args).toContain("--remote-debugging-port=9444");
  });

  test("unsupported platforms need an explicit executable", () => {
    const win = { vaultPath: "C:/v/D", platform: "win32" as const, env: {} };
    expect(() => captureLaunchCommand(win, resolveCaptureProfile(win))).toThrow(
      /pass --obsidian-app/,
    );
    const explicit = { ...win, obsidianApp: "C:/Obsidian/Obsidian.exe" };
    expect(captureLaunchCommand(explicit, resolveCaptureProfile(explicit)).file).toBe(
      "C:/Obsidian/Obsidian.exe",
    );
  });

  test("profile registers the vault and warns about an empty core-plugins.json", async () => {
    const dir = await createTempDir(tempDirectories, "capture-launch-");
    const vault = path.join(dir, "Vault");
    await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
    await fs.writeFile(path.join(vault, ".obsidian", "core-plugins.json"), "[]");
    const profile = await prepareCaptureProfile({
      vaultPath: vault,
      root: path.join(dir, "root"),
      platform: "linux",
    });
    const registry = JSON.parse(
      await fs.readFile(path.join(profile.userDataPath, "obsidian.json"), "utf8"),
    ) as { cli: boolean; vaults: Record<string, { path: string; open: boolean }> };
    expect(registry.cli).toBe(true);
    expect(Object.values(registry.vaults)).toEqual([
      expect.objectContaining({ path: vault, open: true }),
    ]);
    expect(profile.warnings.join()).toMatch(/core-plugins\.json is \[\]/);
    await expect(
      prepareCaptureProfile({ vaultPath: path.join(dir, "missing"), root: path.join(dir, "r2") }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("capture screenshot", () => {
  test("clips in CSS px with padding and verifies the DPR-scaled PNG size", async () => {
    const fake = await fakeClient((method, params) => {
      if (method === "Page.captureScreenshot") return { result: { data: pngHeader(1160, 440) } };
      const expression = expr(params);
      if (expression.includes("vw: innerWidth")) {
        return value({
          rect: { x: 360, y: 200, width: 560, height: 200 },
          vw: 1280,
          vh: 800,
          dpr: 2,
        });
      }
      return value(true);
    });
    const dir = await createTempDir(tempDirectories, "capture-shot-");
    const info = await captureScreenshot(fake.client, path.join(dir, "m.png"), {
      target: { kind: "modal" },
      pad: 10,
    });
    expect(info).toMatchObject({
      width: 1160,
      height: 440,
      clip: { x: 350, y: 190, width: 580, height: 220 },
    });
    const shot = fake.sent.find((m) => m.method === "Page.captureScreenshot");
    expect(shot?.params).toMatchObject({
      clip: { x: 350, y: 190, width: 580, height: 220, scale: 1 },
    });
    // The target marker is always cleaned up afterwards.
    expect(String(fake.sent.at(-1)?.params.expression)).toContain("removeAttribute");
  });

  test("refuses off-screen targets and wrong-size output instead of writing a bad image", async () => {
    const offscreen = await fakeClient((_m, params) =>
      expr(params).includes("vw: innerWidth")
        ? value({ rect: { x: 0, y: -40, width: 560, height: 1200 }, vw: 1280, vh: 800, dpr: 2 })
        : value(true),
    );
    await expect(
      captureScreenshot(offscreen.client, "/nonexistent/x.png", { target: { kind: "modal" } }),
    ).rejects.toThrow(/exceeds the 1280x800 viewport/);

    const wrongSize = await fakeClient((method, params) => {
      if (method === "Page.captureScreenshot") return { result: { data: pngHeader(100, 100) } };
      return expr(params).includes("vw: innerWidth")
        ? value({ rect: { x: 0, y: 0, width: 1280, height: 800 }, vw: 1280, vh: 800, dpr: 2 })
        : value(true);
    });
    await expect(captureScreenshot(wrongSize.client, "/nonexistent/y.png")).rejects.toThrow(
      /expected 2560x1600/,
    );
  });

  test("missing modal is a clear error", async () => {
    const fake = await fakeClient(() => value(false));
    await expect(
      captureScreenshot(fake.client, "/nonexistent/z.png", { target: { kind: "modal" } }),
    ).rejects.toThrow(/No open modal/);
  });

  test("pngSize rejects non-PNG bytes", () => {
    expect(pngSize(Buffer.from(pngHeader(3, 4), "base64"))).toEqual({ width: 3, height: 4 });
    expect(() => pngSize(Buffer.from("nope"))).toThrow(/not a PNG/);
  });
});

describe("capture connect", () => {
  test("picks the main workspace even when a popout is listed first", async () => {
    const socketFor = (isMain: boolean): CdpSocket => {
      let listener: (data: string) => void = () => {};
      return {
        send: (data) => {
          const message = JSON.parse(data) as { id: number; params: { expression: string } };
          const popoutCheck = message.params.expression.includes("is-popout-window");
          queueMicrotask(() =>
            listener(JSON.stringify({ id: message.id, ...value(popoutCheck ? isMain : true) })),
          );
        },
        close: () => {},
        onMessage: (l) => {
          listener = l;
        },
      };
    };
    const connected: string[] = [];
    const client = await connectCapture({
      timeoutMs: 1000,
      deps: {
        fetchJson: () =>
          Promise.resolve([
            {
              type: "page",
              url: "app://obsidian.md/index.html",
              webSocketDebuggerUrl: "ws://popout",
            },
            {
              type: "page",
              url: "app://obsidian.md/index.html",
              webSocketDebuggerUrl: "ws://main",
            },
          ]),
        connect: (url) => {
          connected.push(url);
          return Promise.resolve(socketFor(url === "ws://main"));
        },
      },
    });
    expect(client).toBeInstanceOf(CdpClient);
    expect(connected).toEqual(["ws://popout", "ws://main"]);
  });
});

describe("capture connect candidates", () => {
  test("a failing earlier candidate does not hide a healthy later one", async () => {
    let listener: (data: string) => void = () => {};
    const healthy: CdpSocket = {
      send: (data) => {
        const message = JSON.parse(data) as { id: number };
        queueMicrotask(() => listener(JSON.stringify({ id: message.id, ...value(true) })));
      },
      close: () => {},
      onMessage: (l) => {
        listener = l;
      },
    };
    const client = await connectCapture({
      timeoutMs: 1000,
      deps: {
        fetchJson: () =>
          Promise.resolve([
            {
              type: "page",
              url: "app://obsidian.md/index.html",
              webSocketDebuggerUrl: "ws://broken",
            },
            {
              type: "page",
              url: "app://obsidian.md/index.html",
              webSocketDebuggerUrl: "ws://main",
            },
          ]),
        connect: (url) =>
          url === "ws://broken"
            ? Promise.reject(new Error("handshake rejected"))
            : Promise.resolve(healthy),
      },
    });
    expect(client).toBeInstanceOf(CdpClient);
  });
});

describe("capture connect deadline", () => {
  test("a WebSocket handshake that never settles still honours the timeout", async () => {
    const started = Date.now();
    await expect(
      connectCapture({
        timeoutMs: 300,
        deps: {
          fetchJson: () =>
            Promise.resolve([
              { type: "page", url: "app://obsidian.md/index.html", webSocketDebuggerUrl: "ws://x" },
            ]),
          connect: () => new Promise<CdpSocket>(() => {}),
        },
      }),
    ).rejects.toThrow(/did not become ready: timed out/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("capture prepare", () => {
  test("a size-only prepare leaves the capture CSS alone; an explicit false rewrites it", async () => {
    const state = { width: 1280, height: 800, devicePixelRatio: 2, theme: "light" };
    const fake = await fakeClient((_m, params) =>
      value(expr(params).includes("const out = { width: innerWidth") ? state : true),
    );
    const touchesStyle = () =>
      fake.sent.some((m) => expr(m.params).includes("obsidian-e2e-capture-style"));
    await prepareCapture(fake.client, { width: 1280, height: 800 });
    expect(touchesStyle()).toBe(false);
    await prepareCapture(fake.client, { hideSecretWarning: false });
    expect(touchesStyle()).toBe(true);
  });
});

describe("capture type", () => {
  test("maps in-page outcomes to errors", async () => {
    const cases = [
      ["missing", /No element matches/],
      ["noteditable", /not an editable element/],
      ["nofocus", /No editable element/],
      ["rejected", /does not accept text/],
    ] as const;
    for (const [outcome, message] of cases) {
      const fake = await fakeClient(() => value(outcome));
      await expect(
        typeText(fake.client, "hi", { selector: outcome === "nofocus" ? undefined : ".x" }),
      ).rejects.toThrow(message);
    }
    const ok = await fakeClient(() => value("ok"));
    await expect(typeText(ok.client, "hi")).resolves.toBeUndefined();
  });
});

describe("capture record", () => {
  test("concat list gives each frame its real duration and extends the last to stop", () => {
    const list = buildConcatList(
      [
        { file: "/t/a.jpg", timestamp: 10.1 },
        { file: "/t/b.jpg", timestamp: 10.5 },
      ],
      10,
      12,
    );
    expect(list).toBe(
      "ffconcat version 1.0\nfile '/t/a.jpg'\nduration 0.5000\nfile '/t/b.jpg'\nduration 1.5000\nfile '/t/b.jpg'\n",
    );
    expect(() => buildConcatList([], 0, 1)).toThrow(/no frames/);
    // A frame stamped before start does not stretch the timeline.
    const early = buildConcatList(
      [
        { file: "/t/a.jpg", timestamp: 9.9 },
        { file: "/t/b.jpg", timestamp: 10.5 },
      ],
      10,
      11,
    );
    expect(early).toContain("duration 0.5000\nfile '/t/b.jpg'\nduration 0.5000");
    // An instant take still holds its only frame for one output frame.
    expect(buildConcatList([{ file: "/t/a.jpg", timestamp: 5 }], 5, 5.01, 0.1)).toContain(
      "duration 0.1000",
    );
  });

  test("an explicit x11 backend refuses to fall back when x11 is unusable", async () => {
    const fake = await fakeClient(() => value({ reason: "no X11 DISPLAY" }));
    await expect(
      startRecording(fake.client, "/nonexistent/x.webm", { backend: "x11" }),
    ).rejects.toThrow(/x11 backend unavailable: no X11 DISPLAY/);
  });

  test("aborting the signal cancels a screencast setup that never gets an answer", async () => {
    const fake = await fakeClient((method) =>
      method === "Page.enable" ? { id: -1 } : { result: {} },
    );
    const before = new Set(await fs.readdir(os.tmpdir()));
    const controller = new AbortController();
    const starting = startRecording(fake.client, "/tmp/never.webm", {
      backend: "screencast",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(starting).rejects.toThrow(/recording (setup )?cancelled/);
    const leftovers = (await fs.readdir(os.tmpdir())).filter(
      (name) => name.startsWith("obsidian-e2e-rec-") && !before.has(name),
    );
    expect(leftovers).toEqual([]);
  }, 10_000);

  test("aborting cancels x11 detection that never gets an answer", async () => {
    const fake = await fakeClient(() => ({ id: -1 }));
    const controller = new AbortController();
    const starting = startRecording(fake.client, "/tmp/never.webm", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(starting).rejects.toThrow(/recording (setup )?cancelled/);
  });

  test("stop({signal}) aborts a zero-frame still fallback the renderer never answers", async () => {
    const fake = await fakeClient((method) =>
      method === "Page.captureScreenshot" ? { id: -1 } : { result: {} },
    );
    const before = new Set(await fs.readdir(os.tmpdir()));
    const recording = await startRecording(fake.client, "/tmp/never.webm", {
      backend: "screencast",
    });
    const controller = new AbortController();
    const stopping = recording.stop({ signal: controller.signal });
    setTimeout(() => controller.abort(), 400);
    const started = Date.now();
    await expect(stopping).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(3000);
    const leftovers = (await fs.readdir(os.tmpdir())).filter(
      (name) => name.startsWith("obsidian-e2e-rec-") && !before.has(name),
    );
    expect(leftovers).toEqual([]);
  }, 10_000);

  test("only webm/mp4 outputs are accepted", () => {
    expect(encoderArgs("x.webm", 10)).toContain("libvpx-vp9");
    expect(encoderArgs("x.mp4", 10)).toContain("libx264");
    expect(() => encoderArgs("x.gif", 10)).toThrow(/Unsupported recording format/);
  });

  test("abort stops the screencast, removes frames, and never touches an existing output", async () => {
    const fake = await fakeClient(() => ({ result: {} }));
    const dir = await createTempDir(tempDirectories, "capture-rec-");
    const output = path.join(dir, "take.webm");
    await fs.writeFile(output, "previous good take");
    const before = new Set(await fs.readdir(os.tmpdir()));
    const recording = await startRecording(fake.client, output, { backend: "screencast" });
    fake.emit("Page.screencastFrame", {
      sessionId: 1,
      data: Buffer.from("jpeg").toString("base64"),
      metadata: { timestamp: Date.now() / 1000 },
    });
    await new Promise((r) => setTimeout(r, 10));
    await recording.abort();
    const leftovers = (await fs.readdir(os.tmpdir())).filter(
      (name) => name.startsWith("obsidian-e2e-rec-") && !before.has(name),
    );
    expect(leftovers).toEqual([]);
    expect(await fs.readFile(output, "utf8")).toBe("previous good take");
    const methods = fake.sent.map((m) => m.method);
    expect(methods).toContain("Page.screencastFrameAck");
    expect(methods).toContain("Page.stopScreencast");
  });
});

describe("CdpClient extensions", () => {
  test("call throws on protocol errors; a dropped socket fails pending calls fast", async () => {
    const fake = await fakeClient((method) =>
      method === "Bad.method" ? { error: { message: "nope" } } : { result: { ok: 1 } },
    );
    await expect(fake.client.call("Good.method")).resolves.toEqual({ ok: 1 });
    await expect(fake.client.call("Bad.method")).rejects.toThrow(/Bad.method failed: nope/);
    fake.drop();
    await expect(fake.client.call("Good.method")).rejects.toThrow(/socket closed/);
  });

  test("close() fails a call whose reply never arrives", async () => {
    const fake = await fakeClient((method) =>
      method === "Hang.forever" ? { id: -1 } : { result: {} },
    );
    const pending = fake.client.call("Hang.forever");
    fake.client.close();
    await expect(pending).rejects.toThrow(/socket closed/);
  });

  test("a custom target selector with no match reports it generically", async () => {
    await expect(
      CdpClient.connect(9333, {
        fetchJson: () => Promise.resolve([{ type: "page", url: "about:blank" }]),
        selectTarget: () => undefined,
      }),
    ).rejects.toThrow(/No matching page target on CDP port 9333/);
  });
});
