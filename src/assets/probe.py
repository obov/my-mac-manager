# m3 probe: runs on the target Mac (ssh stdin, /usr/bin/python3 3.9 standard library). Prints state as JSON.
# Built-in facts (now, boot, console_user, procs, ports, dirs) + plugin collector results (facts[name]).
# Collector code can use this file's globals (sh, HOME, parse_ts, etime_sec, imported modules).
import base64, datetime, glob, json, os, re, shutil, subprocess, sys, time

HOME = os.path.expanduser("~")


def sh(cmd, timeout=20):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""


def etime_sec(s):
    s = s.strip()
    days = 0
    if "-" in s:
        d, s = s.split("-", 1)
        days = int(d)
    parts = [int(x) for x in s.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, sec = parts
    return days * 86400 + h * 3600 + m * 60 + sec


def procs():
    res = []
    for line in sh(["ps", "-axo", "pid=,ppid=,etime=,rss=,command="]).splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)", line)
        if m:
            res.append({"pid": int(m[1]), "ppid": int(m[2]), "age": etime_sec(m[3]),
                        "rss_mb": int(m[4]) // 1024, "cmd": m[5]})
    return res


def ports():
    res, pid, cmd = [], None, None
    for line in sh(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]).splitlines():
        k, v = line[0], line[1:]
        if k == "p":
            pid = int(v)
        elif k == "c":
            cmd = v
        elif k == "n":
            port = int(v.rsplit(":", 1)[1])
            res.append({"port": port, "addr": v.rsplit(":", 1)[0], "pid": pid, "cmd": cmd})
    seen, uniq = set(), []
    for r in res:
        key = (r["port"], r["pid"])
        if key not in seen:
            seen.add(key)
            uniq.append(r)
    return uniq


TS = re.compile(r"(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?")


def parse_ts(line):
    """ISO timestamp near the start of a line → epoch. Local time when no zone is given."""
    m = TS.search(line[:60])
    if not m:
        return None
    try:
        tz = m[4] or ""
        if tz == "Z":
            tz = "+00:00"
        elif tz and ":" not in tz:
            tz = tz[:3] + ":" + tz[3:]
        if tz:
            return datetime.datetime.fromisoformat(f"{m[1]}T{m[2]}{tz}").timestamp()
        return time.mktime(time.strptime(f"{m[1]} {m[2]}", "%Y-%m-%d %H:%M:%S"))
    except ValueError:
        return None


def main(fragments_b64, audit_root):
    boot = re.search(r"sec = (\d+)", sh(["sysctl", "-n", "kern.boottime"]))
    root = os.path.expanduser(audit_root) if audit_root else None
    facts = {
        "now": int(time.time()),
        "boot": int(boot[1]) if boot else None,
        "console_user": sh(["stat", "-f", "%Su", "/dev/console"]).strip(),
        "procs": procs(),
        "ports": ports(),
        "dirs": sorted(os.path.basename(d) for d in glob.glob(root + "/*") if os.path.isdir(d)) if root else [],
    }
    for name, code, arg in json.loads(base64.b64decode(fragments_b64).decode()):
        ns = dict(globals())
        try:
            exec(compile(code, "<m3:" + name + ">", "exec"), ns)
            facts[name] = ns["collect"](arg, facts)
        except Exception as e:
            facts.setdefault("_errors", {})[name] = (type(e).__name__ + ": " + str(e))[:300]
    print(json.dumps(facts))
