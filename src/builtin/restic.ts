import RESTIC_PY from "../assets/restic.py";
import type { Backup, Context, CredState, Plugin } from "../types.js";
import { isUpperKey, sha256, shq } from "../util.js";

const SCRIPT = "m3-restic.py";

class Restic implements Backup {
  credentials;
  constructor(private ctx: Context) {
    const o = ctx.options;
    this.credentials = {
      required: o.required ?? ["RESTIC_REPOSITORY", "RESTIC_PASSWORD"],
      optional: o.optional ?? [],
      aliases: {
        "restic_password": "RESTIC_PASSWORD", "restic-password": "RESTIC_PASSWORD", "restic password": "RESTIC_PASSWORD",
        "@password": "RESTIC_PASSWORD",
        ...Object.fromEntries(Object.entries(o.aliases ?? {}).map(([k, v]) => [k.toLowerCase(), v as string])),
      },
    };
  }

  private get o() { return this.ctx.options; }
  private get envFile() { return this.o.env_file ?? "restic.env"; }
  private get pwFile(): string { return this.o.password_file ?? ""; }

  remoteOptions() {
    return {
      restic_host: this.o.restic_host ?? this.ctx.id,
      repo_suffix: this.o.repo_suffix ?? `/${this.ctx.id}`,
      cred_dir: this.ctx.remote.credDir,
      env_file: this.envFile,
      password_file: this.pwFile,
      keep: this.o.keep ?? { daily: 7, weekly: 4, monthly: 6 },
      path_extra: this.o.path ?? [],
    };
  }

  remoteFiles() {
    return [{ name: SCRIPT, content: RESTIC_PY }];
  }

  agents() {
    const label = this.o.label ?? `${this.ctx.id}.backup`;
    const at = this.o.schedule ?? { hour: 4, minute: 30 };
    const logf = `__HOME__/Library/Logs/${this.ctx.id}-backup.log`;
    return [{
      label,
      plist: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string><string>-I</string>
    <string>__DIR__/${SCRIPT}</string><string>backup</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${at.hour}</integer><key>Minute</key><integer>${at.minute}</integer></dict>
  <key>StandardOutPath</key><string>${logf}</string>
  <key>StandardErrorPath</key><string>${logf}</string>
</dict>
</plist>
`,
    }];
  }

  private conf() {
    return JSON.stringify({ id: this.ctx.id, dir: this.ctx.remote.dir, plan: this.ctx.backupPlan(), backup: this.remoteOptions() });
  }

  async run(action: "now" | "snapshots" | "verify" | "log") {
    if (action === "log") {
      console.log(await this.ctx.remote.run(`tail -30 ~/Library/Logs/${this.ctx.id}-backup.log 2>/dev/null || echo no log`, { check: false }));
      return 0;
    }
    return this.ctx.remote.pythonLive(RESTIC_PY, ["--config-json", this.conf(), action === "now" ? "backup" : action]);
  }

  async restore(what: "secrets" | "dirs" | "data", o: { name?: string; target?: string }) {
    const args = ["--config-json", this.conf(), "restore", what];
    if (o.name) args.push(o.name);
    if (o.target) args.push("--target", o.target);
    return this.ctx.remote.pythonLive(RESTIC_PY, args);
  }

  restoreDataCommand(name: string) {
    return `/usr/bin/python3 -I ~/${this.ctx.remote.dir}/${SCRIPT} restore data ${shq(name)}`;
  }

  async writeCredentials(kv: Record<string, string>) {
    const R = this.ctx.remote, d = `~/${R.credDir}`;
    const pw = kv.RESTIC_PASSWORD;
    const env = Object.entries(kv).filter(([k]) => isUpperKey(k) && !(this.pwFile && k === "RESTIC_PASSWORD"))
      .map(([k, v]) => `${k}=${v}\n`).join("");
    await R.run(`umask 077; mkdir -p ${d} && cat > ${d}/${shq(this.envFile)}`, { stdin: env });
    if (this.pwFile) await R.run(`umask 077; cat > ${d}/${shq(this.pwFile)}`, { stdin: pw + "\n" });
  }

  async compareCredentials(kv: Record<string, string>) {
    // per-key sha256 of the target Mac values (values themselves are never sent or printed)
    const code = `import hashlib,json,os,sys
h=lambda v:hashlib.sha256(v.encode()).hexdigest()
d=os.path.expanduser('~/'+sys.argv[1])
o={}
try:
    for l in open(os.path.join(d,sys.argv[2])):
        l=l.strip()
        if '=' in l and not l.startswith('#'):
            k,v=l.split('=',1);o[k.strip()]=h(v.strip().strip('"').strip("'"))
    if sys.argv[3]:
        o['RESTIC_PASSWORD']=h(open(os.path.join(d,sys.argv[3])).read().strip())
except OSError:
    pass
print(json.dumps(o))
`;
    const remote = JSON.parse((await this.ctx.remote.python(code, [this.ctx.remote.credDir, this.envFile, this.pwFile], { check: false })) || "{}");
    const res: Record<string, CredState> = {};
    for (const [k, v] of Object.entries(kv)) res[k] = remote[k] == null ? "none" : remote[k] === sha256(v) ? "same" : "diff";
    return res;
  }

  async hasCredentials() {
    const d = `~/${this.ctx.remote.credDir}`;
    const files = [this.envFile, this.pwFile].filter(Boolean).map((f) => `test -s ${d}/${shq(f)}`).join(" && ");
    return !!(await this.ctx.remote.run(`${files} && echo y`, { check: false }));
  }
}

const plugin: Plugin = {
  name: "restic",
  description: "restic backup (any restic repository: S3, R2, B2, SFTP, ...)",
  backup: (ctx) => new Restic(ctx),
};
export default plugin;
