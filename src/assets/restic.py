# m3 restic backup / restore. Runs on the target Mac (/usr/bin/python3 3.9 standard library).
#
#   m3-restic.py [--config-json J] backup          secrets, dirs, project data → repository (daily via launchd)
#   m3-restic.py snapshots                         latest snapshot per tag
#   m3-restic.py verify                            restore into a temp dir and check (live data untouched)
#   m3-restic.py restore secrets|dirs [--target DIR]
#   m3-restic.py restore data <project>             dump → stdin of data_restore
#   m3-restic.py raw [--no-suffix] -- <restic args>  run restic with credentials and repository applied
#
# config: --config-json or config.json next to this file ({"plan": ..., "backup": ...}, written by m3 install)
# credentials: ~/<cred_dir>/<env_file> (KEY=VALUE), optional ~/<cred_dir>/<password_file>
import argparse, json, os, shutil, subprocess, sys, tempfile, time

HOME = os.path.expanduser("~")
CONF, PLAN, OPT = {}, {}, {}


def load(a):
    global CONF, PLAN, OPT
    if a.config_json:
        CONF = json.loads(a.config_json)
    else:
        CONF = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")))
    PLAN, OPT = CONF["plan"], CONF["backup"]


def restic_bin():
    return shutil.which("restic") or "/opt/homebrew/bin/restic"


def env(suffix=True):
    e = dict(os.environ)
    e["PATH"] = ":".join([HOME + "/" + CONF["dir"], *[os.path.expanduser(p) for p in OPT.get("path_extra", [])],
                          "/opt/homebrew/bin", "/usr/local/bin", HOME + "/.local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    cred = os.path.join(HOME, OPT["cred_dir"])
    for line in open(os.path.join(cred, OPT["env_file"])):
        line = line.strip()
        if line.startswith("export "):
            line = line[7:]
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            e[k.strip()] = v.strip().strip('"').strip("'")
    if OPT.get("password_file"):
        e["RESTIC_PASSWORD_FILE"] = os.path.join(cred, OPT["password_file"])
        e.pop("RESTIC_PASSWORD", None)
    if suffix and OPT.get("repo_suffix"):
        e["RESTIC_REPOSITORY"] = e["RESTIC_REPOSITORY"].rstrip("/") + OPT["repo_suffix"]
    return e


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def restic(*args, e=None, **kw):
    return subprocess.run([restic_bin(), *args], env=e or env(), **kw)


def existing(paths):
    return [p for p in paths if os.path.lexists(os.path.join(HOME, p))]


def tar_cmd(paths, excludes=()):
    return ["/usr/bin/tar", "-C", HOME, "-cf", "-", *sum((["--exclude", x] for x in excludes), []), *paths]


def stdin_backup(tag, filename, cmd):
    r = restic("backup", "--quiet", "--host", OPT["restic_host"], "--tag", tag, "--stdin-filename", filename,
               "--stdin-from-command", "--", *cmd)
    log(("OK  " if r.returncode == 0 else "FAIL"), tag)
    return r.returncode == 0


def cmd_backup(_):
    e = env()
    if restic("cat", "config", e=e, capture_output=True).returncode != 0:
        log("repo init"); restic("init", e=e, check=True)
    ok = True
    sec = existing(PLAN["secrets"])
    missing = sorted(set(PLAN["secrets"]) - set(sec))
    if missing:
        log("secrets missing (skipped):", " ".join(missing))
    ok &= stdin_backup("secrets", "secrets.tar", tar_cmd(sec))
    ok &= stdin_backup("dirs", "dirs.tar", tar_cmd(existing(PLAN["dirs"]), PLAN["dirs_exclude"]))
    for name, d in PLAN["data"].items():
        ok &= stdin_backup("data-" + name, name + ".data", ["/bin/zsh", "-c", d["backup"]])
    k = OPT.get("keep", {})
    r = restic("forget", "--quiet", "--host", OPT["restic_host"], "--group-by", "host,tags",
               "--keep-daily", str(k.get("daily", 7)), "--keep-weekly", str(k.get("weekly", 4)),
               "--keep-monthly", str(k.get("monthly", 6)), "--prune", e=e)
    ok &= r.returncode == 0
    log("backup complete" if ok else "backup partly failed")
    return 0 if ok else 1


def cmd_snapshots(_):
    out = restic("snapshots", "--host", OPT["restic_host"], "--latest", "1", "--group-by", "tags", "--json",
                 capture_output=True, text=True)
    if out.returncode != 0:
        print(out.stderr.strip()); return 1
    for g in json.loads(out.stdout or "[]"):
        for s in g["snapshots"]:
            size = s.get("summary", {}).get("total_bytes_processed", 0)
            print(f"{','.join(s.get('tags', [])):<20} {s['time'][:16].replace('T', ' ')}  {size / 1e6:8.1f}MB  {s['short_id']}")
    return 0


def dump(tag, filename):
    return subprocess.Popen([restic_bin(), "dump", "--host", OPT["restic_host"], "--tag", tag, "latest", "/" + filename],
                            env=env(), stdout=subprocess.PIPE)


def restore_tar(tag, filename, target):
    os.makedirs(target, exist_ok=True)
    p = dump(tag, filename)
    t = subprocess.run(["/usr/bin/tar", "-x", "-p", "-C", target, "-f", "-"], stdin=p.stdout)
    p.wait()
    return p.returncode or t.returncode


def cmd_restore(a):
    if a.what in ("secrets", "dirs"):
        return restore_tar(a.what, a.what + ".tar", os.path.expanduser(a.target or HOME))
    if a.what == "data":
        if a.name not in PLAN["data"]:
            print("project has no data_backup:", a.name); return 2
        d = PLAN["data"][a.name]
        p = dump("data-" + a.name, a.name + ".data")
        r = subprocess.run(["/bin/zsh", "-c", d["restore"]], stdin=p.stdout, env=env())
        p.wait()
        return p.returncode or r.returncode
    return 2


def count_files(root, rel):
    n = 0
    for p in rel:
        full = os.path.join(root, p)
        if os.path.isfile(full) or os.path.islink(full):
            n += 1
        for _, _, fs in os.walk(full):
            n += len(fs)
    return n


def cmd_verify(_):
    tmp = tempfile.mkdtemp(prefix="m3-verify-")
    ok = True
    try:
        for tag, rel, excl in (("secrets", existing(PLAN["secrets"]), []), ("dirs", existing(PLAN["dirs"]), PLAN["dirs_exclude"])):
            rc = restore_tar(tag, tag + ".tar", f"{tmp}/{tag}")
            got = count_files(f"{tmp}/{tag}", rel)
            print(f"{'OK  ' if rc == 0 and got else 'FAIL'} {tag:<8} {got} files restored")
            ok &= rc == 0 and got > 0
        for name in PLAN["data"]:
            p = dump("data-" + name, name + ".data")
            size = len(p.stdout.read())
            p.wait()
            print(f"{'OK  ' if p.returncode == 0 and size else 'FAIL'} data-{name:<12} {size / 1e6:.2f}MB")
            ok &= p.returncode == 0 and size > 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0 if ok else 1


def cmd_raw(a):
    args = a.args[1:] if a.args[:1] == ["--"] else a.args
    return restic(*args, e=env(suffix=not a.no_suffix)).returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config-json")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("backup"); sub.add_parser("snapshots"); sub.add_parser("verify")
    r = sub.add_parser("restore")
    r.add_argument("what", choices=["secrets", "dirs", "data"])
    r.add_argument("name", nargs="?")
    r.add_argument("--target")
    raw = sub.add_parser("raw")
    raw.add_argument("--no-suffix", action="store_true")
    raw.add_argument("args", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    load(a)
    sys.exit(globals()["cmd_" + a.cmd](a))


if __name__ == "__main__":
    main()
