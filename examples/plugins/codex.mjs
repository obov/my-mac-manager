// m3 plugin: per-project Codex CLI login homes (CODEX_HOME) on the target Mac.
// Each project that uses codex gets its own CODEX_HOME, so one login never leaks into another app.
// Lost logins are detected on the target Mac and mailed (alert plugin) with a link to a tailnet-only
// re-login page: tap "Start login" → the page shows the one-time device code → enter it on auth.openai.com.
//
//   plugins = ["my-mac-manager/examples/plugins/alert.mjs", "my-mac-manager/examples/plugins/codex.mjs"]
//
//   [plugin.codex]
//   bin = "/opt/homebrew/bin/codex"        # default
//   label = "com.me.m3.codex"              # launchd check job (omit = no automatic check)
//   interval = 600                         # local check (auth.json present, refresh token) every interval seconds
//   probe_hours = 6                        # server check (tiny `codex exec`) per home every N hours. 0 = off
//   probe_skip = ["web"]                   # projects never probed (e.g. home shared with a container: no cross-mount auth lock)
//   serve_label = "com.me.m3.codex-login"  # launchd re-login page (omit = no page)
//   port = 8495                            # page listens on 127.0.0.1:port
//   https_port = 18495                     # tailscale serve --https=<https_port> (tailnet only), set up by bootstrap / m3 codex expose
//
//   [projects.web]
//   codex = "~/.config/web/codex"          # CODEX_HOME of this project. Projects without codex: omit the key
//   secrets = ["~/.config/web/codex/auth.json"]   # back up the login (m3 audit warns when missing)
//
//   m3 codex [status [project]]   login state of every codex home (+ last automatic check)
//   m3 codex check [project]      check now, server probe included (mails when logged out)
//   m3 codex login <project>      device-auth login over ssh (terminal)
//   m3 codex logout <project>     `codex logout` in that home
//   m3 codex expose               tailscale serve the re-login page (tailnet only)
//
// Logged out = auth.json missing / unreadable / no refresh token, or the server probe fails with an auth error.
// It stays logged out until auth.json changes (re-login) and a probe passes. Mails repeat per the alert cooldown.
// Home preparation (login, page, bootstrap): mkdir -p, chmod 700, config.toml with cli_auth_credentials_store = "file"
// only when config.toml does not exist (apps that write their own config.toml keep it). Never prints tokens.

const SCRIPT = "m3-codex.py";

// runs on the target Mac (python 3.9 stdlib)
const CODEX_PY = String.raw`
# m3 codex (target Mac). Config: codex.json next to this file (m3 install). State: codex-state.json
#   check [--probe] [project]   local check; server probe every probe_hours (--probe: now). Logged out → m3-alert mail
#   serve                       re-login page on 127.0.0.1:port (tailscale serve → tailnet only)
import base64, calendar, fcntl, html, json, os, re, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlparse

DIR = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(DIR, "codex-state.json")
AUTH_ERR = re.compile(r"\b401\b|unauthori[sz]ed|refresh[ _]token|token[ _]expired|invalid_grant|"
                      r"(log|sign) ?in again|not logged in|logged out|please (log|sign) ?in", re.I)
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
CODE = re.compile(r"\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b")
LINK = re.compile(r"https://[^\s\x1b]+")
LOGIN_SECONDS = 15 * 60


def conf():
    with open(os.path.join(DIR, "codex.json")) as f:
        return json.load(f)


def now():
    return int(time.time())


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), *a, flush=True)


def path(home, name=""):
    return os.path.join(os.path.expanduser(home), name) if name else os.path.expanduser(home)


def env(home):
    e = dict(os.environ)
    e["CODEX_HOME"] = path(home)
    e["PATH"] = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    return e


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def update_state(home, **kw):
    with open(STATE + ".lock", "a") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        s = load_state()
        s.setdefault(home, {}).update(kw)
        with open(STATE + ".tmp", "w") as f:
            json.dump(s, f, indent=1)
        os.replace(STATE + ".tmp", STATE)
        return s[home]


def mtime(home):
    try:
        return int(os.stat(path(home, "auth.json")).st_mtime)
    except OSError:
        return None


def claims(jwt):
    try:
        p = jwt.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
    except Exception:
        return {}


def account(home):
    """(ok, reason, info) from auth.json alone"""
    a = path(home, "auth.json")
    if not os.path.exists(a):
        return False, "not logged in (no auth.json)", {}
    try:
        with open(a) as f:
            j = json.load(f)
    except Exception as e:
        return False, "auth.json unreadable: " + type(e).__name__, {}
    t = j.get("tokens") or {}
    c = claims(t.get("id_token") or "")
    info = {"mode": j.get("auth_mode") or ("apikey" if j.get("OPENAI_API_KEY") else "chatgpt"), "email": c.get("email"),
            "plan": (c.get("https://api.openai.com/auth") or {}).get("chatgpt_plan_type")}
    lr = j.get("last_refresh")
    if lr:
        try:
            info["last_refresh"] = calendar.timegm(time.strptime(lr[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            pass
    if info["mode"] != "apikey" and not t.get("refresh_token"):
        return False, "no refresh token in auth.json", info
    return True, None, info


def probe(cfg, home):
    """tiny codex exec → True (ok) | False (auth error) | None (inconclusive: network, limits, timeout)"""
    with tempfile.TemporaryDirectory() as tmp:
        try:
            r = subprocess.run([cfg["bin"], "exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only",
                                "-c", 'model_reasoning_effort="low"', "Reply with the single word OK."],
                               cwd=tmp, env=env(home), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired:
            return None, "probe timeout (180s)"
        except OSError as e:
            return None, "probe failed to start: " + str(e)
    if r.returncode == 0:
        return True, "probe ok"
    out = ANSI.sub("", (r.stdout or "") + "\n" + (r.stderr or ""))
    lines = [x.strip() for x in out.splitlines() if x.strip()]
    hit = [x for x in lines if AUTH_ERR.search(x)]
    msg = " / ".join((hit or lines)[-3:])[:300] or "exit %d" % r.returncode
    return (False if hit else None), msg


def page_url(cfg):
    if not cfg.get("https_port"):
        return None
    try:
        out = subprocess.run(["/opt/homebrew/bin/tailscale", "status", "--json"], capture_output=True, text=True, timeout=10).stdout
        dns = (json.loads(out).get("Self") or {}).get("DNSName", "").rstrip(".")
    except Exception:
        dns = ""
    return "https://%s:%s/" % (dns, cfg["https_port"]) if dns else None


def alert(cfg, project, home, reason):
    script = os.path.join(DIR, "m3-alert.py")
    if not os.path.exists(script):
        log("no m3-alert.py, not mailed:", project, reason)
        return
    url = page_url(cfg)
    body = [reason, "", "Re-login:"]
    if url:
        body.append("  " + url + "#" + quote(project) + "   (tailnet only: open with Tailscale on, tap Start login)")
    body.append("  m3 codex login " + project + "   (terminal)")
    r = subprocess.run(["/usr/bin/python3", "-I", script, "send", project, "codex login lost: " + home],
                       input="\n".join(body) + "\n", capture_output=True, text=True, timeout=60)
    log("alert", project, (r.stdout or r.stderr).strip())


def check(cfg, force, only):
    bad = 0
    for h in cfg["homes"]:
        if only and h["project"] != only:
            continue
        home, st = h["home"], load_state().get(h["home"], {})
        ok, reason, _ = account(home)
        mt, upd = mtime(home), {"checked": now()}
        probing = h.get("probe", True) and cfg.get("probe_hours", 6) > 0
        if ok and st.get("out") and st.get("out_mtime") == mt and not force:
            ok, reason = False, st.get("reason")            # unchanged since the failure: no new probe needed
        elif ok and probing and (force or st.get("out") or now() - st.get("probed", 0) >= cfg.get("probe_hours", 6) * 3600):
            pok, msg = probe(cfg, home)
            upd.update(probed=now(), probe_ok=pok, probe_msg=msg)
            if pok is False:
                ok, reason = False, "server rejected the login: " + msg
            elif pok is None and st.get("out"):
                ok, reason = False, st.get("reason")         # inconclusive: keep the previous verdict
        if ok:
            upd.update(out=False, reason=None, since=None)
        else:
            bad += 1
            upd.update(out=True, reason=reason, out_mtime=mt, since=st.get("since") if st.get("out") else now())
        update_state(home, **upd)
        log(h["project"], "ok" if ok else "LOGGED OUT", reason or "", ("probe: " + upd["probe_msg"]) if "probe_msg" in upd else "")
        if not ok:
            alert(cfg, h["project"], home, reason)
    return 1 if bad else 0


# ---------- re-login page ----------
SESSIONS, LOCK = {}, threading.Lock()


def prepare(home):
    d = path(home)
    os.makedirs(d, exist_ok=True)
    os.chmod(d, 0o700)
    cfgf = os.path.join(d, "config.toml")
    if not os.path.exists(cfgf):
        with open(cfgf, "w") as f:
            f.write('cli_auth_credentials_store = "file"\n')


def start_login(cfg, h):
    with LOCK:
        s = SESSIONS.get(h["project"])
        if s and s["status"] in ("starting", "waiting") and now() - s["started"] < LOGIN_SECONDS:
            return
        prepare(h["home"])
        p = subprocess.Popen([cfg["bin"], "login", "--device-auth"], cwd=path(h["home"]), env=env(h["home"]),
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        s = SESSIONS[h["project"]] = {"status": "starting", "started": now(), "code": None, "link": None, "tail": []}
    log("login started", h["project"])

    def read():
        for line in p.stdout:
            line = ANSI.sub("", line).strip()
            if not line:
                continue
            s["tail"] = (s["tail"] + [line])[-6:]
            if not s["link"] and LINK.search(line):
                s["link"] = LINK.search(line).group(0)
            if not s["code"] and CODE.search(line):
                s["code"], s["status"] = CODE.search(line).group(0), "waiting"
        rc = p.wait()
        s["status"], s["ended"] = ("done" if rc == 0 else "failed"), now()
        log("login", s["status"], h["project"], "exit", rc)
        if rc == 0:
            update_state(h["home"], out=False, reason=None, since=None, relogin=now())
            threading.Thread(target=check, args=(cfg, True, h["project"]), daemon=True).start()
    threading.Thread(target=read, daemon=True).start()


def ago(t):
    if not t:
        return "-"
    s = max(0, now() - int(t))
    return "%ds" % s if s < 60 else "%dm" % (s // 60) if s < 3600 else "%dh" % (s // 3600) if s < 172800 else "%dd" % (s // 86400)


CSS = """body{font:16px/1.45 -apple-system,system-ui,sans-serif;margin:0 auto;max-width:640px;padding:16px;color:#222;background:#fafafa}
h1{font-size:20px}section{background:#fff;border:1px solid #ddd;border-radius:10px;padding:14px;margin:12px 0}
section:target{border-color:#36c;box-shadow:0 0 0 2px #36c3}h2{font-size:17px;margin:0 0 6px}.ok{color:#16803c}.bad{color:#c62828}
.dim{color:#777;font-size:14px}.code{font:700 30px ui-monospace,Menlo,monospace;letter-spacing:2px;margin:8px 0}
button,.btn{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #36c;background:#36c;color:#fff;text-decoration:none;display:inline-block;margin:4px 6px 4px 0}
.sec{background:#fff;color:#36c}pre{white-space:pre-wrap;font-size:13px;background:#f3f3f3;padding:8px;border-radius:6px}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}section{background:#1b1b1b;border-color:#333}.sec{background:#1b1b1b}pre{background:#222}}"""


def render(cfg):
    st, busy, out = load_state(), False, []
    for h in cfg["homes"]:
        p, home = h["project"], h["home"]
        ok, reason, info = account(home)
        s, hs = SESSIONS.get(p), st.get(home, {})
        if ok and hs.get("out"):
            ok, reason = False, hs.get("reason")
        who = " · ".join(x for x in [info.get("mode"), info.get("email"), info.get("plan")] if x)
        row = ['<section id="%s"><h2>%s <span class="%s">%s</span></h2>' % (html.escape(p, True), html.escape(p),
               "ok" if ok else "bad", "logged in" if ok else "LOGGED OUT")]
        row.append('<div class="dim">%s</div>' % html.escape(home))
        if who:
            row.append("<div>%s</div>" % html.escape(who))
        if reason:
            row.append('<div class="bad">%s</div>' % html.escape(reason))
        row.append('<div class="dim">token refreshed %s ago · checked %s ago · probe %s %s ago</div>' % (
            ago(info.get("last_refresh")), ago(hs.get("checked")),
            {True: "ok", False: "FAILED", None: "inconclusive"}.get(hs.get("probe_ok"), "-") if hs.get("probed") else "-", ago(hs.get("probed"))))
        if s and s["status"] in ("starting", "waiting"):
            busy = True
            if s["code"]:
                left = max(0, LOGIN_SECONDS - (now() - s["started"]))
                row.append('<p>1. Open the link and sign in&nbsp; 2. Enter this code (%d min left)</p>' % (left // 60))
                row.append('<div class="code" id="c-%s">%s</div>' % (html.escape(p, True), html.escape(s["code"])))
                row.append('<a class="btn" target="_blank" rel="noopener" href="%s">Open auth.openai.com</a>' % html.escape(s["link"] or "https://auth.openai.com/codex/device", True))
                row.append('<button class="sec" onclick="navigator.clipboard.writeText(%s);this.textContent=\'Copied\'">Copy code</button>' % html.escape(json.dumps(s["code"]), True))
                row.append('<div class="dim">Only continue if you started this login here. This page refreshes until codex confirms.</div>')
            else:
                row.append("<p>Starting codex login…</p>")
        else:
            if s and s["status"] == "done":
                row.append('<p class="ok">Login completed %s ago.</p>' % ago(s.get("ended")))
            elif s and s["status"] == "failed":
                row.append('<p class="bad">Login failed.</p><pre>%s</pre>' % html.escape("\n".join(s["tail"])))
            row.append('<form method="post" action="/login/%s"><button%s>%s</button></form>' % (
                quote(p), "" if not ok else ' class="sec"', "Start login" if not ok else "Log in again"))
        row.append("</section>")
        out.append("".join(row))
    refresh = '<meta http-equiv="refresh" content="3">' if busy else ""
    return ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '%s<title>codex login</title><style>%s</style></head><body><h1>codex login · %s</h1>%s</body></html>'
            % (refresh, CSS, html.escape(os.uname()[1]), "".join(out) or "<p>no codex homes</p>"))


def serve(cfg):
    homes = {h["project"]: h for h in cfg["homes"]}

    class H(BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):
            pass

        def send(self, code, body=b"", ctype="text/html; charset=utf-8", loc=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "same-origin")
            if loc:
                self.send_header("Location", loc)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if urlparse(self.path).path == "/healthz":
                return self.send(200, b"ok\n", "text/plain")
            if urlparse(self.path).path != "/":
                return self.send(404, b"not found\n", "text/plain")
            self.send(200, render(cfg).encode())

        def do_POST(self):
            parts = urlparse(self.path).path.strip("/").split("/")
            # browsers: Sec-Fetch-Site (Origin can be "null" on form posts); older clients: Origin host = Host
            site, origin = self.headers.get("Sec-Fetch-Site"), self.headers.get("Origin")
            host = (self.headers.get("Host") or "").split(":")[0]
            if (site not in ("same-origin", "none")) if site else (origin and urlparse(origin).hostname != host):
                return self.send(403, b"cross-origin request refused\n", "text/plain")
            if len(parts) != 2 or parts[0] != "login" or unquote(parts[1]) not in homes:
                return self.send(404, b"not found\n", "text/plain")
            p = unquote(parts[1])
            try:
                start_login(cfg, homes[p])
            except Exception as e:
                log("login start failed", p, e)
                return self.send(500, ("login start failed: %s\n" % e).encode(), "text/plain")
            self.send(303, loc="/#" + quote(p))

    srv = ThreadingHTTPServer(("127.0.0.1", int(cfg["port"])), H)
    log("serving 127.0.0.1:%s" % cfg["port"])
    srv.serve_forever()


def main(argv):
    cfg = conf()
    if argv[:1] == ["check"]:
        rest = argv[1:]
        force = "--probe" in rest
        only = next((x for x in rest if not x.startswith("--")), None)
        return check(cfg, force, only)
    if argv[:1] == ["serve"]:
        return serve(cfg)
    if argv[:1] == ["state"]:
        print(json.dumps(load_state()))
        return 0
    sys.exit("usage: m3-codex.py check [--probe] [project] | serve | state")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`;

// collector (status): auth.json summary + last automatic check. arg = { homes: ["~/path"], state: "~/<dir>/codex-state.json" }
const COLLECT = String.raw`
import base64, calendar, json, os, re, time

def _claims(jwt):
    try:
        p = jwt.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
    except Exception:
        return {}

def collect(arg, facts):
    out = {}
    for h in arg["homes"]:
        d = os.path.expanduser(h)
        r = {"dir": os.path.isdir(d), "auth": False}
        try:
            with open(os.path.join(d, "config.toml")) as f:
                m = re.search(r'^\s*cli_auth_credentials_store\s*=\s*"([^"]*)"', f.read(), re.M)
                r["store"] = m.group(1) if m else None
        except OSError:
            r["store"] = None
        a = os.path.join(d, "auth.json")
        try:
            r["auth_perm"] = os.stat(a).st_mode & 0o777
            with open(a) as f:
                j = json.load(f)
            t = j.get("tokens") or {}
            r["auth"] = True
            r["mode"] = j.get("auth_mode") or ("apikey" if j.get("OPENAI_API_KEY") else ("chatgpt" if t else None))
            r["refresh_token"] = bool(t.get("refresh_token"))
            lr = j.get("last_refresh")
            if lr:
                r["last_refresh"] = calendar.timegm(time.strptime(lr[:19], "%Y-%m-%dT%H:%M:%S"))
            c = _claims(t.get("id_token") or "")
            r["email"] = c.get("email")
            r["plan"] = (c.get("https://api.openai.com/auth") or {}).get("chatgpt_plan_type")
        except FileNotFoundError:
            pass
        except Exception as e:
            r["error"] = type(e).__name__ + ": " + str(e)[:120]
        out[h] = r
    try:
        with open(os.path.expanduser(arg["state"])) as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    return {"homes": out, "state": state}
`;

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const home = (p) => (p.startsWith("~/") ? `"$HOME"/${q(p.slice(2))}` : q(p));
const bin = (ctx) => ctx.options.bin ?? "/opt/homebrew/bin/codex";
const users = (ctx) => ctx.projects.filter((p) => typeof p.codex === "string" && p.codex);
const authPath = (p) => p.codex.replace(/\/+$/, "") + "/auth.json";
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const py = (ctx) => `/usr/bin/python3 -I ~/${ctx.remote.dir}/${SCRIPT}`;
const USAGE = "m3 codex [status [project] | check [project] | login <project> | logout <project> | expose]";

/** shell lines: create the home (700) and a file-store config.toml when none exists */
function prepare(h) {
  const d = home(h);
  return `mkdir -p ${d} && chmod 700 ${d} && { [ -e ${d}/config.toml ] || printf 'cli_auth_credentials_store = "file"\\n' > ${d}/config.toml; }`;
}

function remoteConfig(ctx) {
  const o = ctx.options, skip = new Set(o.probe_skip ?? []);
  return {
    bin: bin(ctx),
    probe_hours: Number(o.probe_hours ?? 6),
    port: Number(o.port ?? 8495),
    https_port: o.https_port ? Number(o.https_port) : null,
    homes: users(ctx).map((p) => ({ project: p.name, home: p.codex, probe: !skip.has(p.name) })),
  };
}

function state(ctx, p, r, st, now) {
  if (!r) return { ok: false, info: "not collected" };
  if (r.error) return { ok: false, info: ctx.ui.bad(r.error) };
  if (!r.dir) return { ok: false, info: `no home → m3 codex login ${p.name}` };
  if (!r.auth) return { ok: false, info: `not logged in → m3 codex login ${p.name}` };
  const parts = [r.mode ?? "?"];
  if (r.email) parts.push(r.email + (r.plan ? ` (${r.plan})` : ""));
  if (r.last_refresh) parts.push(`refreshed ${ctx.ui.dur(now - r.last_refresh)} ago`);
  if (st?.probed) parts.push(`probe ${st.probe_ok === true ? "ok" : st.probe_ok === false ? "FAILED" : "inconclusive"} ${ctx.ui.dur(now - st.probed)} ago`);
  const warn = [];
  if (r.auth_perm & 0o077) warn.push(`auth.json mode ${r.auth_perm.toString(8)}`);
  if (r.store && r.store !== "file") warn.push(`config.toml: cli_auth_credentials_store = ${r.store}`);
  if (st?.out) return { ok: false, info: ctx.ui.bad(`LOGGED OUT ${ctx.ui.dur(now - (st.since ?? now))}: ${st.reason}`) + ` → m3 codex login ${p.name}` };
  if (r.mode === "chatgpt" && !r.refresh_token) return { ok: false, info: ctx.ui.bad("no refresh token") + ` → m3 codex login ${p.name}` };
  return { ok: true, info: parts.join(" · ") + (warn.length ? "  " + ctx.ui.warn(warn.join(", ")) : "") };
}

function check(ctx, p, f) {
  if (typeof p.codex !== "string") return [{ ok: false, tag: "codex", what: "codex", info: "codex must be a CODEX_HOME path string" }];
  const s = state(ctx, p, f.codex?.homes?.[p.codex], f.codex?.state?.[p.codex], f.now);
  return [{ ok: s.ok, tag: "codex", what: p.codex, info: s.info }];
}

function audit(ctx) {
  const missing = users(ctx).filter((p) => !(p.secrets ?? []).includes(authPath(p))).map((p) => `${p.name}: ${authPath(p)} not in secrets (no backup)`);
  return missing.length ? [{ title: "codex login not backed up", items: missing }] : [];
}

const collectArg = (ctx) => ({ homes: [...new Set(users(ctx).map((p) => p.codex))], state: `~/${ctx.remote.dir}/codex-state.json` });

async function status(ctx, list) {
  if (!list.length) { console.log(ctx.ui.dim("no project has a codex key")); return 0; }
  const out = await ctx.remote.python(COLLECT + "\nimport sys\nprint(json.dumps(collect(json.loads(sys.argv[1]), {})))\n", [JSON.stringify(collectArg(ctx))]);
  const f = JSON.parse(out), now = Math.floor(Date.now() / 1000), w = Math.max(...list.map((p) => p.name.length));
  let bad = 0;
  for (const p of list) {
    const s = state(ctx, p, f.homes[p.codex], f.state[p.codex], now);
    if (!s.ok) bad++;
    console.log(`${s.ok ? ctx.ui.ok("ok  ") : ctx.ui.bad("FAIL")} ${p.name.padEnd(w)}  ${ctx.ui.dim(p.codex)}  ${s.info}`);
  }
  return bad ? 1 : 0;
}

function project(ctx, name, sub) {
  const list = users(ctx);
  if (!name) ctx.fail(`usage: m3 codex ${sub} <project>\n  codex projects: ${list.map((p) => p.name).join(", ") || "-"}`);
  const p = list.find((x) => x.name === name);
  if (!p) ctx.fail(ctx.projects.some((x) => x.name === name) ? `[projects.${name}] has no codex key` : `unknown project: ${name}`);
  return p;
}

const exposeLine = (ctx) => `/opt/homebrew/bin/tailscale serve --bg --https=${Number(ctx.options.https_port)} http://127.0.0.1:${Number(ctx.options.port ?? 8495)}`;

async function run(ctx, { positionals }) {
  const [sub = "status", name] = positionals;
  if (sub === "status") return status(ctx, name ? [project(ctx, name, "status")] : users(ctx));
  if (sub === "check") {
    if (name) project(ctx, name, "check");
    return ctx.remote.script(`${py(ctx)} check --probe ${name ? q(name) : ""}\n`);
  }
  if (sub === "expose") {
    if (!ctx.options.serve_label || !ctx.options.https_port) ctx.fail("[plugin.codex]: serve_label and https_port are required");
    return ctx.remote.script(exposeLine(ctx) + "\n");
  }
  if (sub === "login" || sub === "logout") {
    const p = project(ctx, name, sub);
    const env = `PATH=/opt/homebrew/bin:$PATH CODEX_HOME=${home(p.codex)} ${q(bin(ctx))}`;
    console.log(ctx.ui.bold(`codex ${sub} ${p.name}`) + ctx.ui.dim(` → ${ctx.remote.host}:${p.codex}`));
    const cmd = sub === "login" ? `${prepare(p.codex)} && ${env} login --device-auth` : `${env} logout`;
    const rc = await ctx.remote.tty(cmd);
    if (rc !== 0) { console.log(ctx.ui.bad(`failed (exit ${rc})`)); return rc; }
    if (ctx.options.label) await ctx.remote.run(`${py(ctx)} check --probe ${q(p.name)}`, { check: false, timeout: 240 });
    return status(ctx, [p]);
  }
  ctx.fail("usage: " + USAGE);
}

function plist(label, args, extra) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((x) => `    <string>${xml(x)}</string>`).join("\n")}
  </array>
${extra}
  <key>StandardOutPath</key><string>__HOME__/Library/Logs/${xml(label)}.log</string>
  <key>StandardErrorPath</key><string>__HOME__/Library/Logs/${xml(label)}.log</string>
</dict>
</plist>
`;
}

/** @type {import("my-mac-manager/plugin").Plugin} */
export default {
  name: "codex",
  apiVersion: 1,
  description: "per-project Codex CLI login homes (CODEX_HOME): status, lost-login mail, tailnet re-login page, backup audit",
  collectors: [{ name: "codex", code: COLLECT, arg: collectArg }],
  services: [{ name: "codex", keys: ["codex"], check, audit }],
  remoteFiles: (ctx) => [
    { name: SCRIPT, content: CODEX_PY, mode: 0o755 },
    { name: "codex.json", content: JSON.stringify(remoteConfig(ctx), null, 1), mode: 0o600 },
  ],
  agents: (ctx) => {
    const o = ctx.options, out = [], args = (cmd) => ["/usr/bin/python3", "-I", `__DIR__/${SCRIPT}`, cmd];
    if (o.label) out.push({ label: o.label, plist: plist(o.label, args("check"), `  <key>StartInterval</key><integer>${Number(o.interval ?? 600)}</integer>\n  <key>RunAtLoad</key><true/>`) });
    if (o.serve_label) out.push({ label: o.serve_label, plist: plist(o.serve_label, args("serve"), "  <key>KeepAlive</key><true/>\n  <key>RunAtLoad</key><true/>") });
    return out;
  },
  commands: [{ name: "codex", summary: "per-project codex login: status / check / login / logout / expose re-login page", usage: USAGE, run }],
  bootstrap: (ctx) => {
    const list = users(ctx);
    if (!list.length) return [];
    const steps = [{ desc: "codex homes (CODEX_HOME 700 + config.toml)", phase: "before-projects",
      run: (c) => c.remote.script([...new Set(list.map((p) => p.codex))].map(prepare).join("\n") + "\n") }];
    if (ctx.options.serve_label && ctx.options.https_port)
      steps.push({ desc: "codex re-login page (tailscale serve, tailnet only)", phase: "finish", run: (c) => c.remote.script(exposeLine(c) + "\n") });
    steps.push({ desc: "codex login state", phase: "finish", run: (c) => status(c, list).then(() => 0) });
    return steps;
  },
};
