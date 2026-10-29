import type { Context, Facts, Plugin, Project, Row } from "../types.js";
import { BAD, DIM, OK, WARN, dur, fail, poll, sleep } from "../util.js";

export const labels = (p: Project): string[] => [...(p.launchd ?? []), ...(p.launchd_jobs ?? [])];

/** labels to look up in the system domain: external LaunchDaemons + labels of daemon=true projects */
export const systemLabels = (projects: Project[]) =>
  projects.flatMap((p) => [...(p.launchd_system ?? []), ...(p.daemon ? labels(p) : [])]);

const COLLECT = String.raw`
def collect(arg, facts):
    loaded = {}
    for line in sh(["launchctl", "list"]).splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        pid, status, label = parts
        if label.startswith("com.apple."):
            continue
        loaded[label] = {"pid": None if pid == "-" else int(pid), "status": int(status)}
    plists = [os.path.basename(p)[:-6] for p in glob.glob(HOME + "/Library/LaunchAgents/*.plist")]
    system = {}
    for lb in arg:
        txt = sh(["launchctl", "print", "system/" + lb])
        if not txt:
            system[lb] = None
            continue
        pid = re.search(r"^\s*pid = (\d+)", txt, re.M)
        ex = re.search(r"last exit code = (\d+)", txt)
        system[lb] = {"pid": int(pid[1]) if pid else None, "status": int(ex[1]) if ex else 0}
    return {"loaded": loaded, "plists": plists, "system": system}
`;

type St = { pid: number | null; status: number } | null | undefined;

function where(lb: string, f: Facts): [string | null, St] {
  const sys = f.launchd.system[lb];
  if (sys) return ["system", sys];
  const g = f.launchd.loaded[lb];
  return g ? ["gui", g] : [null, null];
}

function check(_ctx: Context, p: Project, f: Facts): Row[] {
  const rows: Row[] = [];
  const own = new Set(p.launchd ?? []);
  for (const lb of [...(p.launchd ?? []), ...(p.launchd_system ?? [])]) {
    const [dom, st] = where(lb, f);
    const ok = !!(st && st.pid);
    let info = ok ? `${dom} pid ${st!.pid}` : !st ? "not loaded" : `${dom} stopped (exit ${st.status})`;
    if (ok && p.daemon && dom === "gui") info += DIM("  (not yet a LaunchDaemon)");
    rows.push({ ok, tag: own.has(lb) ? "launchd" : "system", what: lb, info });
  }
  for (const lb of p.launchd_jobs ?? []) {
    const [dom, st] = where(lb, f);
    const ok = !!st && st.status === 0;
    const info = !st ? "not loaded" : `${dom} ` + (st.pid ? "running" : `last exit ${st.status}`);
    rows.push({ ok, tag: "job", what: lb, info });
  }
  return rows;
}

function control(ctx: Context, p: Project, action: "start" | "stop" | "restart") {
  const H = ctx.remote.helper;
  const lines = labels(p).map((lb) => {
    const job = (p.launchd_jobs ?? []).includes(lb);
    const act = job && action === "restart" ? "run" : action;
    const gui = {
      stop: `launchctl print gui/$U/${lb} >/dev/null 2>&1 && launchctl bootout gui/$U/${lb}`,
      start: `launchctl print gui/$U/${lb} >/dev/null 2>&1 || launchctl bootstrap gui/$U ~/Library/LaunchAgents/${lb}.plist`,
      restart: `if launchctl print gui/$U/${lb} >/dev/null 2>&1; then launchctl kickstart -k gui/$U/${lb}; ` +
        `else launchctl bootstrap gui/$U ~/Library/LaunchAgents/${lb}.plist; fi`,
    }[action];
    return `echo "${action} ${lb}"; if [ -f /Library/LaunchDaemons/${lb}.plist ]; then sudo -n ${H} ${act} ${lb}; else ${gui}; fi`;
  });
  const tty = (p.launchd_system ?? []).map((lb: string) => ({
    label: `system ${action} ${lb} (sudo)`,
    cmd: "sudo launchctl " + { start: `kickstart system/${lb}`, stop: `kill TERM system/${lb}`, restart: `kickstart -k system/${lb}` }[action],
  }));
  return { lines, tty };
}

function logs(_ctx: Context, p: Project, n: number) {
  const tail = `for k in StandardOutPath StandardErrorPath; do plutil -extract $k raw -o - "$f" 2>/dev/null; echo; done ` +
    `| sort -u | grep . | while read l; do echo "== $lb: $l"; tail -n ${n} "$l"; done`;
  return [...labels(p), ...(p.launchd_system ?? [])].map(
    (lb) => `lb=${lb}; f=/Library/LaunchDaemons/$lb.plist; [ -f $f ] || f=~/Library/LaunchAgents/$lb.plist; ${tail}`);
}

function audit(ctx: Context, f: Facts) {
  const IGN = ctx.config.ignore ?? {};
  const declared = new Set(ctx.projects.flatMap(labels));
  const ign = new Set<string>(IGN.launchd ?? []);
  const loaded: Record<string, { pid: number | null; status: number }> = f.launchd.loaded;
  const daemons = new Set([...declared].filter((lb) => f.launchd.system[lb]));
  const managed = new Set<number>([
    ...Object.values(loaded).map((v) => v.pid),
    ...Object.values<St>(f.launchd.system).map((v) => v?.pid),
  ].filter((x): x is number => !!x));
  const orphanIgn: string[] = IGN.orphan_cmds ?? [];
  const apps = [...new Set(Object.keys(loaded).filter((lb) => lb.startsWith("application."))
    .map((lb) => lb.split(".").slice(1).filter((x) => !/^\d+$/.test(x) && !x.includes("-")).join(".")))].sort();
  return [
    { title: "launchd jobs not in m3.toml", items: Object.keys(loaded).sort().filter((lb) => !declared.has(lb) && !ign.has(lb) && !lb.startsWith("application."))
        .map((lb) => `${lb}  pid=${loaded[lb].pid ?? "-"} exit=${loaded[lb].status}`) },
    { title: "plist present but not loaded", items: (f.launchd.plists as string[]).filter((lb) => !(lb in loaded) && !ign.has(lb) && !daemons.has(lb)) },
    { title: "declared but no plist", items: [...declared].filter((lb) => !f.launchd.plists.includes(lb)).sort() },
    { title: "loaded in both gui and system", items: [...daemons].filter((lb) => lb in loaded).sort() },
    { title: "orphan processes (outside launchd, gone after reboot)", items: f.procs
        .filter((p) => p.ppid === 1 && !managed.has(p.pid) && (p.cmd.startsWith("/Users/") || p.cmd.startsWith("/opt/homebrew/"))
          && !orphanIgn.some((x) => p.cmd.includes(x)))
        .map((p) => `pid ${String(p.pid).padEnd(6)} ${dur(p.age).padStart(7)} ${String(p.rss_mb).padStart(5)}MB  ${p.cmd.slice(0, 110)}`) },
    ...(apps.length ? [{ title: "GUI apps (info): ", items: apps, note: true }] : []),
  ];
}

function kinds(p: Project) {
  const k: string[] = [];
  for (const [key, tag] of [["launchd", "launchd"], ["launchd_jobs", "job"], ["launchd_system", "system"]])
    if (p[key]?.length) k.push(`${tag}×${p[key].length}`);
  return k;
}

async function daemonize(ctx: Context, project: string | undefined, rollback: boolean): Promise<number> {
  const R = ctx.remote, H = R.helper;
  const byName = (n: string) => ctx.projects.find((p) => p.name === n) ?? ctx.fail(`no such project: ${n}`);
  const names = project ? [project] : ctx.projects.filter((p) => p.daemon).map((p) => p.name);
  if (!(await R.run(`test -x ${H} && sudo -n -l ${H} x >/dev/null 2>&1 && echo y`, { check: false })))
    fail(`${H} / sudoers not installed → m3 host apply`);
  for (const n of names) {
    const p = byName(n);
    if (!p.daemon) { console.log(`${n}: not daemon=true, skipped`); continue; }
    if (!rollback && p.requires && (await R.run(p.requires, { check: false })) === null) {
      console.log(`${WARN("held")} ${n}: requirement not met (${p.requires})`); continue;
    }
    let changed = false;
    for (const lb of labels(p)) {
      const act = rollback ? "demote" : "promote";
      const isD = await R.run(`test -f /Library/LaunchDaemons/${lb}.plist && launchctl print system/${lb} >/dev/null 2>&1 && echo y`, { check: false });
      if (!!isD !== rollback) {  // already in the target state → skip (re-applying restarts the service)
        console.log(`${DIM("keep")} ${lb}  already ${rollback ? "gui" : "system"}`); continue;
      }
      const out = await R.run(`sudo -n ${H} ${act} ${lb} 2>&1`, { check: false });
      console.log(`${out ? OK(act) : BAD(act + " failed")} ${lb}  ${DIM((out ?? "").trim())}`);
      changed = true;
    }
    if (p.daemon_ready && !rollback && changed) {
      const ok = await poll(`${n} ready (daemon_ready)`, () => R.run(`${p.daemon_ready} && echo y`, { check: false, timeout: 20 }), { timeout: 180, every: 10 });
      if (!ok) {
        console.log(BAD(`${n} not ready after switching to LaunchDaemon → rolled back`));
        for (const lb of labels(p)) await R.run(`sudo -n ${H} demote ${lb}`, { check: false });
        return 1;
      }
    }
  }
  await sleep(3000);
  return ctx.status(names);
}

const plugin: Plugin = {
  name: "launchd",
  description: "launchd agents, periodic jobs and system daemons: checks, control, LaunchDaemon switch",
  collectors: [{ name: "launchd", code: COLLECT, arg: (ctx) => systemLabels(ctx.projects) }],
  services: [{ name: "launchd", keys: ["launchd", "launchd_jobs", "launchd_system"], check, control, logs, audit, kinds }],
  projectKeys: ["requires", "daemon_ready"],
  commands: [{
    name: "daemonize",
    summary: "switch daemon=true projects to LaunchDaemons (no GUI login needed)",
    usage: "m3 daemonize [project] [--rollback]",
    options: { rollback: { type: "boolean" } },
    run: (ctx, a) => daemonize(ctx, a.positionals[0], !!a.values.rollback),
  }],
  bootstrap: () => [{ desc: "switch to LaunchDaemons", phase: "finish", run: (ctx) => daemonize(ctx, undefined, false) }],
};
export default plugin;
