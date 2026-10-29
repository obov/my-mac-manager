// Example m3 plugin: long-running agent browsers and Claude Code sessions on the target Mac.
// Shows a collector, commands, a remote file, a scheduled launchd agent and a reboot hook.
//
//   plugins = ["my-mac-manager/examples/plugins/agent-sessions.mjs"]
//
//   [plugin.agent-sessions]
//   hours = 6                          # a browser older than this is stale
//   label = "com.me.agent-reap"        # launchd job that reaps stale browsers every interval seconds
//   interval = 1800
//   targets = { terminal-browser = "/terminal-browser.app/Contents/MacOS/terminal-browser" }   # name → executable path suffix
//
//   m3 stale [-H 6]          stale agent browsers + last activity of claude sessions
//   m3 reap [-H 6] [--yes]   terminate stale browsers (dry run by default)

const DEFAULT_TARGETS = {
  "terminal-browser": "/terminal-browser.app/Contents/MacOS/terminal-browser",
  "agent-browser": "/agent-browser/bin/agent-browser",
};

// runs on the target Mac (python 3.9 stdlib): reap.py --hours N --targets JSON [--dry-run]
const REAP = String.raw`
import argparse, datetime, json, os, re, signal, subprocess, time

def etime_sec(s):
    days = 0
    if "-" in s:
        d, s = s.split("-", 1)
        days = int(d)
    parts = [int(x) for x in s.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]

def tree_mb(pid, rows):
    kids, own = {}, {}
    for p, pp, _, rss, _ in rows:
        kids.setdefault(pp, []).append(p)
        own[p] = rss
    total, stack = 0, [pid]
    while stack:
        cur = stack.pop()
        total += own.get(cur, 0)
        stack.extend(kids.get(cur, []))
    return total // 1024

def find(hours, targets):
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,etime=,rss=,command="], capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)", line)
        if m:
            rows.append((int(m[1]), int(m[2]), etime_sec(m[3]), int(m[4]), m[5]))
    hits = []
    for pid, _, age, _, cmd in rows:
        for name, pat in targets.items():
            # main process only (not helpers / renderers): path followed by a space or the end
            if re.search(re.escape(pat) + r"(\s|$)", cmd) and age >= hours * 3600:
                hits.append({"pid": pid, "name": name, "age_h": age // 3600, "mb": tree_mb(pid, rows)})
    return hits

ap = argparse.ArgumentParser()
ap.add_argument("--hours", type=float, default=6)
ap.add_argument("--targets", required=True)
ap.add_argument("--dry-run", action="store_true")
a = ap.parse_args()
hits = find(a.hours, json.loads(a.targets))
stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
for h in hits:
    print(f"{stamp} {'DRY' if a.dry_run else 'KILL'} {h['name']} pid={h['pid']} age={h['age_h']}h mem~{h['mb']}MB")
if not a.dry_run and hits:
    for h in hits:
        try:
            os.kill(h["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass
    time.sleep(10)
    for h in hits:
        try:
            os.kill(h["pid"], signal.SIGKILL)
            print(f"{stamp} SIGKILL pid={h['pid']}")
        except ProcessLookupError:
            pass
`;

// collector: claude processes, their cwd and minutes since the last transcript write
const CLAUDE = String.raw`
def collect(arg, facts):
    def cwd(pid):
        for line in sh(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"]).splitlines():
            if line.startswith("n"):
                return line[1:]
        return None
    res = []
    for p in facts["procs"]:
        if os.path.basename(p["cmd"].split(" ")[0]) != "claude":
            continue
        d = cwd(p["pid"])
        m = re.search(r"CLAUDE_CONFIG_DIR=(\S+)", sh(["ps", "eww", "-o", "command=", "-p", str(p["pid"])]))
        cfg = m[1] if m else HOME + "/.claude"
        last = None
        if d:
            files = glob.glob(cfg + "/projects/" + re.sub(r"[^a-zA-Z0-9]", "-", d) + "/*.jsonl")
            if files:
                last = int(time.time() - max(os.path.getmtime(f) for f in files))
        res.append({"pid": p["pid"], "age": p["age"], "cwd": d, "idle": last, "rss_mb": p["rss_mb"]})
    return res
`;

const hours = (ctx, v = {}) => Number(v.hours ?? ctx.options.hours ?? 6);
const targets = (ctx) => JSON.stringify(ctx.options.targets ?? DEFAULT_TARGETS);
const reap = (ctx, h, dry) =>
  ctx.remote.python(REAP, ["--hours", String(h), "--targets", targets(ctx), ...(dry ? ["--dry-run"] : [])]);
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** @type {import("my-mac-manager/plugin").Plugin} */
export default {
  name: "agent-sessions",
  apiVersion: 1,
  description: "stale agent browsers and claude session activity",
  collectors: [{ name: "claude", code: CLAUDE }],
  remoteFiles: () => [{ name: "agent-reap.py", content: REAP }],
  agents: (ctx) => {
    if (!ctx.options.label) return [];
    const log = `__HOME__/Library/Logs/${ctx.id}-agent-reap.log`;
    const args = ["/usr/bin/python3", "-I", "__DIR__/agent-reap.py", "--hours", String(hours(ctx)), "--targets", targets(ctx)];
    return [{
      label: ctx.options.label,
      plist: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(ctx.options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((x) => `    <string>${xml(x)}</string>`).join("\n")}
  </array>
  <key>StartInterval</key><integer>${Number(ctx.options.interval ?? 1800)}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`,
    }];
  },
  hooks: {
    beforeReboot(ctx, f) {
      const s = f.claude ?? [];
      if (!s.length) return [];
      const active = s.filter((x) => x.idle != null && x.idle < 3600);
      return [
        ctx.ui.warn(`${s.length} claude sessions will end (${active.length} active in the last hour)`),
        ...s.map((x) => `  idle ${ctx.ui.dur(x.idle).padStart(6)}  ${x.cwd}`),
        ctx.ui.dim("  resume: claude --resume in that directory"),
      ];
    },
  },
  commands: [
    {
      name: "stale",
      summary: "stale agent browsers + last activity of claude sessions",
      usage: "m3 stale [-H 6]",
      options: { hours: { type: "string", short: "H" } },
      async run(ctx, { values }) {
        const h = hours(ctx, values), { ui } = ctx;
        const out = ((await reap(ctx, h, true)) ?? "").trim();
        console.log(ui.warn(`browsers (older than ${h}h)`));
        console.log("  " + (out ? out.replace(/\n/g, "\n  ") : ui.ok("none")));
        const f = await ctx.probe();
        console.log(`\n${ui.warn("claude sessions")}  ${ui.dim("idle = time since the last transcript write")}`);
        for (const cs of [...f.claude].sort((a, b) => (b.idle ?? 0) - (a.idle ?? 0))) {
          const idle = ui.dur(cs.idle).padStart(6);
          const mark = cs.idle != null && cs.idle > h * 3600 ? ui.bad(idle) : idle;
          console.log(`  pid ${String(cs.pid).padEnd(6)} age ${ui.dur(cs.age).padStart(6)}  idle ${mark}  ${String(cs.rss_mb).padStart(4)}MB  ${cs.cwd}`);
        }
      },
    },
    {
      name: "reap",
      summary: "terminate stale agent browsers (dry run by default)",
      usage: "m3 reap [-H 6] [--yes]",
      options: { hours: { type: "string", short: "H" }, yes: { type: "boolean" } },
      async run(ctx, { values }) {
        const out = ((await reap(ctx, hours(ctx, values), !values.yes)) ?? "").trim();
        console.log(out || ctx.ui.ok("nothing to reap"));
        if (out && !values.yes) console.log(ctx.ui.dim("dry run. To terminate: m3 reap --yes"));
      },
    },
  ],
};
