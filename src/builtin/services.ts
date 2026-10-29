// docker, compose, apps, heartbeat, logscan(errors), ports
import type { Context, Facts, Plugin, Project, Row } from "../types.js";
import { DIM, dur } from "../util.js";

const dockerBin = (ctx: Context) => ctx.config.plugin?.docker?.bin ?? "/opt/homebrew/bin/docker";

// ---------- docker ----------
const DOCKER = String.raw`
def collect(arg, facts):
    b = arg if os.path.exists(arg) else (shutil.which("docker") or arg)
    res = []
    for line in sh([b, "ps", "-a", "--format", "{{json .}}"]).splitlines():
        try:
            c = json.loads(line)
        except ValueError:
            continue
        res.append({"name": c["Names"], "state": c["State"], "status": c["Status"], "ports": c["Ports"]})
    return res
`;

export const docker: Plugin = {
  name: "docker",
  description: "containers running; audit of undeclared containers",
  collectors: [{ name: "docker", code: DOCKER, arg: dockerBin }],
  services: [{
    name: "docker",
    keys: ["docker"],
    check: (_c, p, f) => (p.docker as string[]).map((dn) => {
      const d = (f.docker ?? []).find((x: any) => x.name === dn);
      return { ok: !!(d && d.state === "running"), tag: "docker", what: dn, info: d ? d.status : "missing" };
    }),
    kinds: (p) => [`docker×${p.docker.length}`],
    audit: (ctx, f) => {
      const declared = new Set(ctx.projects.flatMap((p) => p.docker ?? []));
      const ign: string[] = ctx.config.ignore?.docker_exited ?? [];
      return [{ title: "containers not in m3.toml", items: (f.docker ?? []).filter((d: any) => !declared.has(d.name) && !ign.includes(d.name))
        .map((d: any) => `${d.name}  ${d.state}  ${d.ports}`) }];
    },
  }],
};

// ---------- compose ----------
export const compose: Plugin = {
  name: "compose",
  description: "docker compose control and logs (compose = command prefix)",
  services: [{
    name: "compose",
    keys: ["compose"],
    control: (_c, p, action) => {
      const cmd = { start: "up -d", stop: "stop", restart: "restart" }[action];
      return { lines: [`echo "compose ${cmd}"; ${p.compose} ${cmd}`] };
    },
    logs: (_c, p, n) => [`echo "== compose"; ${p.compose} logs --tail ${n} --no-color`],
  }],
};

// ---------- apps ----------
export const apps: Plugin = {
  name: "apps",
  description: "apps that must be running (executable path prefix)",
  services: [{
    name: "apps",
    keys: ["apps"],
    check: (_c, p, f) => (p.apps as string[]).map((app) => {
      const hit = f.procs.find((x) => x.cmd.startsWith(app));
      return { ok: !!hit, tag: "app", what: app.split("/").pop()!, info: hit ? `pid ${hit.pid}  ${dur(hit.age)}` : "not running" };
    }),
    kinds: (p) => [`app×${p.apps.length}`],
  }],
};

// ---------- heartbeat ----------
const FILES = String.raw`
def collect(arg, facts):
    out = {}
    for raw in arg:
        f = os.path.expanduser(raw)
        try:
            with open(f, "rb") as fh:
                fh.seek(0, 2); fh.seek(max(0, fh.tell() - 4096))
                last = fh.read().decode("utf-8", "replace").strip().splitlines()[-1]
            out[raw] = {"age": int(time.time() - os.path.getmtime(f)), "last": last}
        except (OSError, IndexError):
            out[raw] = None
    return out
`;

export const heartbeat: Plugin = {
  name: "heartbeat",
  description: "last jsonl line has status=ok and was written within max_minutes",
  collectors: [{ name: "heartbeat", code: FILES, arg: (ctx) => ctx.projects.filter((p) => p.heartbeat).map((p) => p.heartbeat.file) }],
  services: [{
    name: "heartbeat",
    keys: ["heartbeat"],
    check: (_c, p, f) => {
      const hb = p.heartbeat;
      const x = f.heartbeat?.[hb.file];
      let ok = false, info = "no file";
      if (x) {
        let last: any = {};
        try { last = JSON.parse(x.last); } catch { last = {}; }
        const st = last.status ?? "?";
        ok = x.age <= hb.max_minutes * 60 && st === "ok";
        info = `${st} ${dur(x.age)} ago` + (st !== "ok" ? ` (${last.reason || last.failedStep || ""})` : "");
        if (x.age > hb.max_minutes * 60) info += `  older than ${hb.max_minutes}m`;
      }
      return [{ ok, tag: "recent", what: hb.file.split("/").pop(), info }];
    },
  }],
};

// ---------- logscan (errors) ----------
const LOGSCAN = String.raw`
def collect(arg, facts):
    docker = arg["docker"] if os.path.exists(arg["docker"]) else (shutil.which("docker") or arg["docker"])
    by_pid = {p["pid"]: p for p in facts["procs"]}
    boot = facts["boot"] or 0

    def label_start(lb):
        for dom in ("system/" + lb, f"gui/{os.getuid()}/" + lb):
            m = re.search(r"^\s*pid = (\d+)", sh(["launchctl", "print", dom]), re.M)
            if m and int(m[1]) in by_pid:
                return time.time() - by_pid[int(m[1])]["age"]
        return None

    def scan(lines, start, match, ignore):
        rx, ig = re.compile(match), [re.compile(x) for x in ignore]
        n, samples, cur = 0, [], None
        for line in lines:
            t = parse_ts(line)
            cur = t if t is not None else cur
            if cur is None or cur < start - 1:
                continue
            if rx.search(line) and not any(x.search(line) for x in ig):
                n += 1
                samples = (samples + [line.strip()[:240]])[-3:]
        return n, samples

    out = {}
    for sp in arg["specs"]:
        key, match, ignore = sp["key"], sp.get("match", "(?i)error|fatal|panic"), sp.get("ignore", [])
        try:
            if sp.get("docker"):
                st = sh([docker, "inspect", "-f", "{{.State.StartedAt}}", sp["docker"]]).strip()
                start = parse_ts(st)
                if start is None:
                    out[key] = {"error": "no such container"}; continue
                r = subprocess.run([docker, "logs", "--timestamps", "--since", st, sp["docker"]],
                                   capture_output=True, text=True, timeout=20, errors="replace")
                lines = (r.stdout + r.stderr).splitlines()
            else:
                start = label_start(sp["since"]) if sp.get("since") else boot
                if start is None:
                    out[key] = {"error": f"{sp['since']} not running"}; continue
                lines = []
                for f in sorted(glob.glob(os.path.expanduser(sp["file"])), key=os.path.getmtime):
                    if os.path.getmtime(f) < start:
                        continue
                    with open(f, "rb") as fh:
                        fh.seek(0, 2); fh.seek(max(0, fh.tell() - 4_000_000))
                        lines += fh.read().decode("utf-8", "replace").splitlines()
            n, samples = scan(lines, start, match, ignore)
            out[key] = {"count": n, "samples": samples, "since": int(start)}
        except Exception as e:
            out[key] = {"error": str(e)[:200]}
    return out
`;

export const logscan: Plugin = {
  name: "logscan",
  description: "no error lines in logs since the service started (errors key)",
  collectors: [{
    name: "logscan",
    code: LOGSCAN,
    arg: (ctx) => ({
      docker: dockerBin(ctx),
      specs: ctx.projects.flatMap((p) => (p.errors ?? []).map((e: any, i: number) => ({ ...e, key: `${p.name}#${i}` }))),
    }),
  }],
  services: [{
    name: "logscan",
    keys: ["errors"],
    check: (_c, p, f) => (p.errors as any[]).map((e, i): Row => {
      const r = f.logscan?.[`${p.name}#${i}`] ?? { error: "no result" };
      const what = e.docker || e.file.split("/").pop();
      if (r.error) return { ok: false, tag: "errors", what, info: r.error };
      let info = `${r.count} errors in ${dur(f.now - r.since)} since start`;
      if (r.count) info += "  " + DIM(r.samples[r.samples.length - 1].slice(0, 110));
      return { ok: r.count === 0, tag: "errors", what, info };
    }),
  }],
};

// ---------- ports ----------
export const ports: Plugin = {
  name: "ports",
  description: "ports in LISTEN; audit of undeclared ports",
  services: [{
    name: "ports",
    keys: ["ports"],
    check: (_c, p: Project, f: Facts) => {
      const listening = new Set(f.ports.map((x) => x.port));
      const miss = (p.ports as number[]).filter((x) => !listening.has(x));
      return [{ ok: !miss.length, tag: "ports", what: p.ports.join(","), info: miss.length ? `not listening [${miss.join(", ")}]` : "LISTEN" }];
    },
    audit: (ctx, f) => {
      const IGN = ctx.config.ignore ?? {};
      const declared = new Set(ctx.projects.flatMap((p) => p.ports ?? []));
      const ignCmds: string[] = IGN.port_cmds ?? [];
      return [{ title: "LISTEN ports not in m3.toml", items: f.ports
        .filter((p) => !declared.has(p.port) && !(IGN.ports ?? []).includes(p.port) && !ignCmds.some((c) => (p.cmd ?? "").startsWith(c)))
        .map((p) => `${String(p.port).padEnd(6)} ${p.cmd} (pid ${p.pid}, ${p.addr})`) }];
    },
  }],
};
