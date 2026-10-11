import fs from "node:fs/promises";
import path from "node:path";

// Keeps the real wrapper's quoting: Xvfb gets `-auth $AUTHFILE` unquoted, and
// the command runs with `XAUTHORITY=$AUTHFILE`.
const XVFB_RUN = `#!/bin/sh
while [ "\${1#-}" != "$1" ]; do
  case "$1" in -f) AUTHFILE=$2; shift ;; -s) shift ;; esac
  shift
done
[ -n "$AUTHFILE" ] || { echo "xvfb-run: no -f, would mktemp" >&2; exit 2; }
: > "$AUTHFILE"
xvfb() { [ "$#" -eq 2 ] && [ -f "$2" ]; }
xvfb -auth $AUTHFILE || { echo "Xvfb: bad -auth" >&2; exit 1; }
DISPLAY=:99 XAUTHORITY=$AUTHFILE exec "$@"
`;

export interface RecordedLaunch {
  cwd: string;
  xauthority: string;
  args: string[];
}

export async function installXvfbStandIns(dir: string): Promise<{
  app: string;
  readLaunch: () => Promise<RecordedLaunch>;
}> {
  const record = path.join(dir, "launch.txt");
  const app = path.join(dir, "app");
  await fs.writeFile(path.join(dir, "xvfb-run"), XVFB_RUN, { mode: 0o755 });
  await fs.writeFile(
    app,
    `#!/bin/sh\n{ pwd -P; printf '%s\\n' "$XAUTHORITY" "$@"; } > '${record}.tmp' && mv '${record}.tmp' '${record}'\n`,
    { mode: 0o755 },
  );
  return {
    app,
    readLaunch: async () => {
      const [cwd = "", xauthority = "", ...args] = (await fs.readFile(record, "utf8"))
        .trimEnd()
        .split("\n");
      return { cwd, xauthority, args };
    },
  };
}
