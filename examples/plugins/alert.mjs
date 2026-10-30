// m3 plugin: error mail alerts sent by apps on the target Mac (e.g. an automation's login session expired).
// Every event and its delivery result is kept in SQLite on the target Mac; failed sends are retried.
//
//   plugins = ["my-mac-manager/examples/plugins/alert.mjs"]
//
//   [plugin.alert]
//   to = "me@example.com"
//   smtp_env = "~/.config/m3/alert.env"   # on the target Mac: SMTP_HOST SMTP_PORT (465 SSL, else STARTTLS) SMTP_USER SMTP_PASS
//   label = "com.me.m3.alert"             # launchd job: retry failed sends (+ watch log files) every interval seconds
//   interval = 120
//   cooldown_minutes = 180                # the same error (digits / timestamps ignored) is mailed again only after this
//
//   [projects.web]
//   alert = true                                         # app calls m3-alert.py itself → alert row in m3 status
//   alert = { files = ["~/Library/Logs/web.log"], match = " ERROR ", ignore = ["harmless"] }   # also watch log lines
//
// Apps on the target Mac (path: ~/.local/share/<id>/m3-alert.py, pass it to the app e.g. as env M3_ALERT):
//   m3-alert.py send <project> "subject" < body           exit 0 = sent or suppressed (cooldown)
//   m3-alert.py run <project> -- cmd ...                   output passed through; exit != 0 → mail with the output tail
//
//   m3 alert [log [project] [-n 20]]   events and delivery state      m3 alert test   test mail
//   m3 alert scan                      send / retry now               m3 alert send <project> <message>

const SCRIPT = "m3-alert.py";

// runs on the target Mac (python 3.9 stdlib)
const ALERT_PY = String.raw`
# m3 alert (target Mac). Config: alert.json next to this file (m3 install). Events: alert.db (SQLite)
#   send <project> [subject] < body | run <project> -- cmd ... | scan | log [n] [project] | summary | test
import fcntl, json, os, re, smtplib, socket, sqlite3, ssl, subprocess, sys, time
from collections import deque
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

DIR = os.path.dirname(os.path.abspath(__file__))
MAX_ATTEMPTS, KEEP_DAYS, MAX_LINES = 5, 90, 20


def conf():
    with open(os.path.join(DIR, "alert.json")) as f:
        return json.load(f)


def db():
    c = sqlite3.connect(os.path.join(DIR, "alert.db"), timeout=30)
    c.row_factory = sqlite3.Row
    c.executescript("""
    create table if not exists events (
      id integer primary key, at integer not null, project text not null, source text not null,
      sig text not null, subject text not null, body text not null,
      status text not null,          -- pending | sent | failed | suppressed
      attempts integer not null default 0, error text, sent_at integer);
    create index if not exists events_project on events(project, at);
    create table if not exists offsets (file text primary key, inode integer, pos integer);
    """)
    return c


def now():
    return int(time.time())


def host(cfg):
    return cfg.get("host") or socket.gethostname()


def sig(line):
    """same error at another time / with other numbers → same signature (cooldown)"""
    s = re.sub(r"\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?", "", line)
    return re.sub(r"\d+", "#", s).strip()[:200]


def record(c, cfg, project, source, lines, cooldown=None):
    """one event. Within the cooldown after the same error was mailed → suppressed. Returns status"""
    lines = [x.rstrip() for x in lines if x.strip()]
    if not lines:
        return None
    s = sig(lines[0])
    cd = 60 * (cooldown if cooldown is not None else cfg.get("cooldown_minutes", 180))
    prev = c.execute("select max(at) from events where project=? and sig=? and status in ('sent','pending','failed')",
                     (project, s)).fetchone()[0]
    status = "suppressed" if prev and now() - prev < cd else "pending"
    body = "\n".join(lines[-MAX_LINES:])
    if len(lines) > MAX_LINES:
        body = "... (%d earlier lines omitted)\n" % (len(lines) - MAX_LINES) + body
    c.execute("insert into events(at, project, source, sig, subject, body, status) values (?,?,?,?,?,?,?)",
              (now(), project, source, s, "[%s] %s: %s" % (host(cfg), project, lines[0][:120]), body, status))
    c.commit()
    return status


def smtp_env(cfg):
    path = os.path.expanduser(cfg["smtp_env"])
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("export "):
                line = line[7:]
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS"):
        if not env.get(k):
            raise RuntimeError(path + ": " + k + " missing")
    return env


def mail(cfg, subject, body):
    env = smtp_env(cfg)
    m = EmailMessage()
    m["From"] = "m3 alert <%s>" % env["SMTP_USER"]
    m["To"] = cfg["to"]
    m["Subject"] = subject
    m["Date"] = formatdate(localtime=True)
    m["Message-ID"] = make_msgid(domain=env["SMTP_USER"].split("@")[-1])
    m.set_content(body + "\n")
    port = int(env.get("SMTP_PORT") or 465)
    ctx = ssl.create_default_context()
    if port == 465:
        s = smtplib.SMTP_SSL(env["SMTP_HOST"], port, timeout=30, context=ctx)
    else:
        s = smtplib.SMTP(env["SMTP_HOST"], port, timeout=30)
        s.starttls(context=ctx)
    with s:
        s.login(env["SMTP_USER"], env["SMTP_PASS"])
        s.send_message(m)


def flush(c, cfg):
    """send pending + failed with attempts left → number of failures"""
    bad = 0
    for r in c.execute("select * from events where status in ('pending','failed') and attempts < ? order by id", (MAX_ATTEMPTS,)).fetchall():
        at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["at"]))
        try:
            mail(cfg, r["subject"], "%s\n\n--\nproject: %s\nsource: %s\nat: %s\nevent: #%d" % (r["body"], r["project"], r["source"], at, r["id"]))
            c.execute("update events set status='sent', attempts=attempts+1, error=null, sent_at=? where id=?", (now(), r["id"]))
        except Exception as e:
            bad += 1
            c.execute("update events set status='failed', attempts=attempts+1, error=? where id=?", ((type(e).__name__ + ": " + str(e))[:300], r["id"]))
        c.commit()
    return bad


def read_new(c, path):
    """complete lines appended since the last scan. First sight of a file → start at its end (no history)"""
    try:
        st = os.stat(path)
    except OSError:
        return []
    row = c.execute("select inode, pos from offsets where file=?", (path,)).fetchone()
    if row is None:
        c.execute("insert into offsets values (?,?,?)", (path, st.st_ino, st.st_size))
        return []
    pos = row["pos"] if row["inode"] == st.st_ino and row["pos"] <= st.st_size else 0   # rotated / truncated
    with open(path, "rb") as f:
        f.seek(pos)
        data = f.read(8000000)
    end = data.rfind(b"\n") + 1
    c.execute("update offsets set inode=?, pos=? where file=?", (st.st_ino, pos + end, path))
    return data[:end].decode("utf-8", "replace").splitlines()


def scan(c, cfg):
    for sp in cfg.get("watch", []):
        rx = re.compile(sp.get("match") or r"(?i)\b(error|fatal|panic)\b")
        ig = [re.compile(x) for x in sp.get("ignore", [])]
        for raw in sp["files"]:
            groups = {}
            for x in read_new(c, os.path.expanduser(raw)):
                if rx.search(x) and not any(i.search(x) for i in ig):
                    groups.setdefault(sig(x), []).append(x)
            for lines in groups.values():
                record(c, cfg, sp["project"], raw, lines, sp.get("cooldown_minutes"))
        c.commit()
    c.execute("delete from events where at < ?", (now() - KEEP_DAYS * 86400,))
    c.commit()


def locked(fn):
    with open(os.path.join(DIR, ".alert.lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        return fn()


def main(argv):
    cmd = argv[0] if argv else "scan"
    cfg, c = conf(), db()
    if cmd == "scan":
        bad = locked(lambda: (scan(c, cfg), flush(c, cfg))[1])
        if bad:
            print(time.strftime("%Y-%m-%dT%H:%M:%S"), bad, "send failures", flush=True)
        return 1 if bad else 0
    if cmd == "send":
        if len(argv) < 2:
            sys.exit("usage: m3-alert.py send <project> [subject] < body")
        body = "" if sys.stdin.isatty() else sys.stdin.read()
        st = record(c, cfg, argv[1], "send", ([argv[2]] if len(argv) > 2 else []) + body.splitlines() or ["(no message)"])
        if st != "pending":
            print("suppressed (cooldown)")
            return 0
        bad = locked(lambda: flush(c, cfg))
        print("send failed, retried later (m3 alert log)" if bad else "sent")
        return 1 if bad else 0
    if cmd == "run":
        if len(argv) < 4 or argv[2] != "--":
            sys.exit("usage: m3-alert.py run <project> -- cmd ...")
        tail = deque(maxlen=MAX_LINES)
        p = subprocess.Popen(argv[3:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for b in p.stdout:
            sys.stdout.buffer.write(b)
            sys.stdout.flush()
            tail.append(b.decode("utf-8", "replace"))
        rc = p.wait()
        if rc != 0:
            name = os.path.basename(argv[3])
            if record(c, cfg, argv[1], "run " + name, ["%s exited %d" % (name, rc)] + list(tail)) == "pending":
                locked(lambda: flush(c, cfg))
        return rc
    if cmd == "log":
        n = int(argv[1]) if len(argv) > 1 else 20
        q, args = "select id, at, project, source, subject, body, status, attempts, error, sent_at from events", []
        if len(argv) > 2:
            q, args = q + " where project=?", [argv[2]]
        for r in c.execute(q + " order by id desc limit ?", args + [n]):
            print(json.dumps(dict(r), ensure_ascii=False))
        return 0
    if cmd == "test":
        try:
            mail(cfg, "[%s] m3 alert test" % host(cfg), "m3 alert test mail")
        except Exception as e:
            print("send failed: %s: %s" % (type(e).__name__, e))
            return 1
        print("sent to " + cfg["to"])
        return 0
    sys.exit("unknown command: " + cmd)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`;

// m3 status: per-project counts from alert.db (probe on the target Mac)
const SUMMARY = String.raw`
def collect(arg, facts):
    import sqlite3
    f = os.path.join(HOME, arg, "alert.db")
    if not os.path.exists(f):
        return {}
    c = sqlite3.connect(f, timeout=10)
    out = {}
    for project, status, n, last, subject in c.execute(
            "select project, status, count(*), max(at), (select subject from events e2 where e2.project=e.project "
            "and e2.status=e.status order by id desc limit 1) from events e group by project, status"):
        out.setdefault(project, {})[status] = {"n": n, "last": last, "subject": subject}
    return out
`;

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const USAGE = "m3 alert [log [project] [-n 20] | scan | test | send <project> <message>]";

function remoteConfig(ctx) {
  const o = ctx.options;
  if (!o.to || !o.smtp_env) ctx.fail("[plugin.alert]: to and smtp_env are required");
  return {
    to: o.to,
    smtp_env: o.smtp_env,
    host: o.host ?? ctx.config.host?.ssh,
    cooldown_minutes: o.cooldown_minutes ?? 180,
    watch: ctx.projects.filter((p) => p.alert?.files).map((p) => ({
      project: p.name, files: p.alert.files, match: p.alert.match, ignore: p.alert.ignore ?? [], cooldown_minutes: p.alert.cooldown_minutes,
    })),
  };
}

function check(ctx, p, f) {
  const s = f.alert?.[p.name] ?? {};
  const failed = s.failed?.n ?? 0;
  const last = ["sent", "failed", "pending"].filter((k) => s[k]).map((k) => ({ k, ...s[k] })).sort((a, b) => b.last - a.last)[0];
  let info = last ? `last ${last.k} ${ctx.ui.dur(f.now - last.last)} ago  ` + ctx.ui.dim(String(last.subject).replace(/^\[[^\]]*\] [^:]*: /, "").slice(0, 80))
    : "no events";
  if (failed) info = `${failed} undelivered → m3 alert log  ` + info;
  return [{ ok: !failed, tag: "alert", what: `mail ${s.sent?.n ?? 0} sent`, info }];
}

async function command(ctx, sub, args, n) {
  const R = ctx.remote, py = `/usr/bin/python3 -I ~/${R.dir}/${SCRIPT}`;
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  if (sub === "scan" || sub === "test") return R.script(`${py} ${sub}\n`);
  if (sub === "send") {
    if (args.length < 2) ctx.fail("usage: m3 alert send <project> <message>");
    return R.script(`${py} send ${q(args[0])} ${q(args.slice(1).join(" "))} </dev/null\n`);
  }
  if (sub !== "log") ctx.fail("usage: " + USAGE);
  const out = await R.run(`${py} log ${Number(n) || 20} ${args[0] ? q(args[0]) : ""}`);
  const rows = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).reverse();
  if (!rows.length) { console.log(ctx.ui.dim("no events")); return 0; }
  const color = { sent: ctx.ui.ok, failed: ctx.ui.bad, pending: ctx.ui.warn, suppressed: ctx.ui.dim };
  const t = (s) => new Date(s * 1000).toLocaleString("sv-SE").slice(0, 16);
  for (const r of rows) {
    console.log(`#${String(r.id).padEnd(5)} ${t(r.at)}  ${(color[r.status] ?? String)(r.status.padEnd(10))} ${r.project}  ${ctx.ui.dim(r.source)}`);
    console.log(`       ${String(r.body).split("\n")[0].slice(0, 140)}`);
    if (r.error) console.log(`       ${ctx.ui.bad(r.error)}  ${ctx.ui.dim(`(attempts ${r.attempts})`)}`);
  }
  return rows.some((r) => r.status === "failed") ? 1 : 0;
}

/** @type {import("my-mac-manager/plugin").Plugin} */
export default {
  name: "alert",
  apiVersion: 1,
  description: "error mail alerts sent by apps (m3-alert.py) or from watched logs; events and delivery kept on the target Mac",
  collectors: [{ name: "alert", code: SUMMARY, arg: (ctx) => ctx.remote.dir }],
  services: [{ name: "alert", keys: ["alert"], check }],
  remoteFiles: (ctx) => [
    { name: SCRIPT, content: ALERT_PY, mode: 0o755 },
    { name: "alert.json", content: JSON.stringify(remoteConfig(ctx), null, 1), mode: 0o600 },
  ],
  agents: (ctx) => {
    if (!ctx.options.label) return [];
    const log = `__HOME__/Library/Logs/${ctx.id}-alert.log`;
    const args = ["/usr/bin/python3", "-I", `__DIR__/${SCRIPT}`, "scan"];
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
  <key>StartInterval</key><integer>${Number(ctx.options.interval ?? 120)}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`,
    }];
  },
  commands: [{
    name: "alert",
    summary: "error mail alerts: event log / retry now / test mail / send",
    usage: USAGE,
    options: { lines: { type: "string", short: "n", default: "20" } },
    run: (ctx, a) => command(ctx, a.positionals[0] ?? "log", a.positionals.slice(1), a.values.lines),
  }],
};
