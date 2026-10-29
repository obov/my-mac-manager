// install / host / bootstrap
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import HELPER_SH from "../assets/launchd-helper.sh";
import HOST_SH from "../assets/host-settings.sh";
import type { Agent, RemoteFile, Step } from "../types.js";
import { BAD, BOLD, DIM, OK, WARN, fail, shHome, shq } from "../util.js";
import type { App } from "./app.js";
import { cmdCreds, cmdEnv } from "./secrets.js";
import { renderAgent, renderBrewfile, renderTools } from "./render.js";
import { cmdLs } from "./status.js";

// writes files into ~/<dir>, removes files deployed last time but no longer wanted (.m3-files.json manifest)
const WRITE_FILES = `import json,os,sys
d=os.path.expanduser("~/"+sys.argv[1])
os.makedirs(d,exist_ok=True)
files=json.load(sys.stdin)
names=[f["name"] for f in files]
man=os.path.join(d,".m3-files.json")
try: old=json.load(open(man))
except (OSError,ValueError): old=[]
for f in files:
    p=os.path.join(d,f["name"]);t=p+".m3-tmp"
    with open(t,"w") as fh: fh.write(f["content"])
    os.chmod(t,f.get("mode",0o644));os.replace(t,p)
for n in old:
    if n not in names and "/" not in n and os.path.isfile(os.path.join(d,n)):
        os.remove(os.path.join(d,n));print("removed",n)
json.dump(names,open(man,"w"))
`;

const marker = (id: string) => id.replace(/[^a-z0-9]/gi, "").toUpperCase() + "Managed";

function dataFile(app: App, p: string) {
  const f = resolve(app.root, p);
  if (!existsSync(f)) fail(`file not found: ${f} (paths are relative to m3.toml)`);
  return readFileSync(f, "utf8");
}

/** files to upload to the target Mac: core + data (host/*) + plugins + [remote].files */
export function remoteFiles(app: App): RemoteFile[] {
  const H = app.cfg.host ?? {};
  const files: RemoteFile[] = [
    { name: `${app.id}-launchd`, content: HELPER_SH.replace(/__ID__/g, app.id).replace(/__MARKER__/g, marker(app.id)), mode: 0o755 },
    { name: "host-settings.sh", content: HOST_SH },
  ];
  if (app.cfg.brew) files.push({ name: "Brewfile", content: renderBrewfile(app.cfg.brew) });
  else if (H.brewfile) files.push({ name: "Brewfile", content: dataFile(app, H.brewfile) });
  if (app.cfg.tools) files.push({ name: "tools.sh", content: renderTools(app.cfg.tools), mode: 0o755 });
  else if (H.tools) files.push({ name: "tools.sh", content: dataFile(app, H.tools), mode: 0o755 });
  if (H.settings) files.push({ name: "host-settings.local.sh", content: dataFile(app, H.settings) });
  for (const p of app.plugins) files.push(...(p.remoteFiles?.(app.ctx(p)) ?? []));
  if (app.backupPlugin) files.push(...(app.backup().remoteFiles?.() ?? []));
  for (const f of app.cfg.remote?.files ?? []) files.push({ name: basename(f), content: dataFile(app, f), mode: 0o755 });
  const names = new Set<string>();
  for (const f of files) {
    if (names.has(f.name)) fail(`duplicate remote file name: ${f.name}`);
    names.add(f.name);
  }
  return files;
}

/** plists for ~/Library/LaunchAgents: [[projects.<name>.agents]] + [host].launchd (files / dirs) + plugins + backup */
export function agents(app: App): Agent[] {
  const out: Agent[] = app.projects.flatMap((p) => (p.agents ?? []).map((a: any) => renderAgent(p, a)));
  for (const spec of app.cfg.host?.launchd ?? []) {
    const p = resolve(app.root, spec);
    const list = existsSync(p) && !p.endsWith(".plist") ? readdirSync(p).filter((f) => f.endsWith(".plist")).map((f) => join(p, f)) : [p];
    for (const f of list) out.push({ label: basename(f, ".plist"), plist: dataFile(app, f) });
  }
  for (const p of app.plugins) out.push(...(p.agents?.(app.ctx(p)) ?? []));
  if (app.backupPlugin) out.push(...(app.backup().agents?.() ?? []));
  const seen = new Set<string>();
  for (const a of out) {
    if (seen.has(a.label)) fail(`launchd label defined twice: ${a.label}`);
    seen.add(a.label);
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export async function pushFiles(app: App, load: boolean) {
  const R = app.remote;
  const home = (await R.run("echo $HOME"))!.trim();
  await R.run(`mkdir -p ~/${R.dir} ~/Library/Logs ~/Library/LaunchAgents`);
  const files = remoteFiles(app);
  const conf = { id: app.id, dir: R.dir, plan: app.backupPlan(), backup: app.backupPlugin ? app.backup().remoteOptions?.() ?? {} : {} };
  files.push({ name: "config.json", content: JSON.stringify(conf, null, 1), mode: 0o600 });
  const removed = (await R.run(`/usr/bin/python3 -I -c ${shq(WRITE_FILES)} ${shq(R.dir)}`, { stdin: JSON.stringify(files) }))!.trim();
  if (removed) console.log(DIM("  " + removed.split("\n").join(", ")));
  console.log(DIM(`  ${R.host}:~/${R.dir}  ${files.map((f) => f.name).join(", ")}`));
  for (const a of agents(app)) {
    const lb = a.label;
    const body = a.plist.replace(/__HOME__/g, home).replace(/__DIR__/g, `${home}/${R.dir}`);
    await R.run(`cat > ~/Library/LaunchAgents/${lb}.plist && plutil -lint -s ~/Library/LaunchAgents/${lb}.plist`, { stdin: body });
    if (!load) continue;
    const out = await R.run(`U=$(id -u); if [ -f /Library/LaunchDaemons/${lb}.plist ]; then sudo -n ${R.helper} promote ${lb}; ` +
      `else launchctl bootout gui/$U/${lb} 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10; do launchctl print gui/$U/${lb} >/dev/null 2>&1 || break; sleep 1; done; ` +
      `launchctl bootstrap gui/$U ~/Library/LaunchAgents/${lb}.plist && echo gui; fi`, { check: false });
    console.log(`${out ? OK("loaded") : BAD("failed")} ${lb} ${DIM(out ? out.trim().split("\n").pop() : "")}`);
  }
}

export async function cmdInstall(app: App) {
  await pushFiles(app, true);
  if (app.backupPlugin && !(await app.backup().hasCredentials())) console.log(WARN(`no credentials in ~/${app.remote.credDir} → m3 creds push`));
  return 0;
}

function hostEnv(app: App, hostname?: string) {
  const hn = hostname ?? app.cfg.host?.hostname ?? "";
  return `M3_ID=${shq(app.id)} M3_DIR=${shq(app.remote.dir)} M3_HOSTNAME=${shq(hn)}` +
    (app.cfg.host?.settings ? " M3_EXTRA=host-settings.local.sh" : "");
}

export async function cmdHost(app: App, action: string) {
  if (!["plan", "apply"].includes(action)) fail("usage: m3 host plan|apply");
  await pushFiles(app, false);
  const s = `sh ~/${app.remote.dir}/host-settings.sh`;
  if (action === "plan") return app.remote.script(`${hostEnv(app)} ${s} plan\n`);
  return app.remote.tty(`sudo ${hostEnv(app)} ${s} apply`);
}

// ---------- bootstrap ----------
const gitClone = (repo: string, dest: string) =>
  `[ -d ${dest}/.git ] || { mkdir -p $(dirname ${dest}) && git clone ${shq(repo)} ${dest}; }`;

type BStep = { desc: string; run: () => Promise<number | void> };

function bootstrapSteps(app: App, hostname?: string): BStep[] {
  const R = app.remote, H = app.cfg.host ?? {}, D = R.dir;
  const run = (script: string) => () => R.script(script);
  const clones = [...app.projects.filter((p) => p.repo), ...(app.cfg.workspace?.repos ?? [])].map((p: any) => [p.repo, p.clone]);
  const pluginSteps = (phase: Step["phase"]) => app.plugins.flatMap((p) =>
    (p.bootstrap?.(app.ctx(p)) ?? []).filter((s) => s.phase === phase).map((s) => ({ desc: s.desc, run: () => s.run(app.ctx(p)) })));
  const steps: BStep[] = [
    { desc: "Homebrew + Xcode CLT", run: async () => (await R.run("test -x /opt/homebrew/bin/brew && echo y", { check: false })) ? 0
      : R.tty('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"') },
    { desc: "deploy m3 files (scripts, config, plists not loaded)", run: () => pushFiles(app, false) },
  ];
  if (app.cfg.brew || H.brewfile) steps.push({ desc: "brew bundle", run: run(`eval $(/opt/homebrew/bin/brew shellenv); HOMEBREW_BUNDLE_MAS_SKIP=\${MAS_SKIP:-} brew bundle --file ~/${D}/Brewfile\n`) });
  if (app.backupPlugin) {
    if (app.vaultPlugin) steps.push({ desc: `backup credentials (vault → ~/${R.credDir})`, run: () => cmdCreds(app, "push") });
    steps.push({ desc: "restore secrets (→ $HOME)", run: () => app.backup().restore("secrets", {}) });
  }
  if (app.vaultPlugin) steps.push({ desc: ".env files (vault → target Mac, wins over the backup)", run: () => cmdEnv(app, "pull", [], true) });
  if (app.backupPlugin) steps.push({ desc: "restore dirs (→ $HOME)", run: () => app.backup().restore("dirs", {}) });
  if (app.cfg.tools || H.tools) steps.push({ desc: "install tools", run: run(`zsh ~/${D}/tools.sh\n`) });
  steps.push(
    { desc: "repo clone", run: run("ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null\n" + clones.map(([r, d]) => gitClone(r, d)).join("\n") + "\n") },
    { desc: "apply host settings (sudo)", run: () => R.tty(`sudo ${hostEnv(app, hostname)} sh ~/${D}/host-settings.sh apply`) },
    ...pluginSteps("before-projects"),
  );
  const path = [...(app.cfg.bootstrap?.path ?? ["~/.local/bin"])].map(shHome).join(":");
  for (const p of app.projects) {
    const cmds: string[] = [];
    if (p.data_restore && app.backupPlugin) cmds.push(app.backup().restoreDataCommand(p.name));
    if (app.backupPlugin) cmds.push(...(app.backup().projectRestoreCommands?.(p) ?? []));
    cmds.push(...(p.setup ?? []));
    if (!cmds.length) continue;
    const body = `set -e\nexport PATH=${path}:$PATH M3_DIR=$HOME/${D}\n` + cmds.join("\n") + "\n";
    if (cmds.some((x) => x.includes("sudo"))) steps.push({ desc: `project ${p.name} (sudo)`, run: () => R.tty("zsh -l -c " + shq(body)) });
    else steps.push({ desc: `project ${p.name}`, run: run(body) });
  }
  steps.push({ desc: "load launchd jobs", run: () => pushFiles(app, true) }, ...pluginSteps("finish"), { desc: "final check", run: () => cmdLs(app) });
  return steps;
}

export async function cmdBootstrap(app: App, target: string, o: { from: number; only?: number; list: boolean; hostname?: string }) {
  app.remote.host = target;
  const steps = bootstrapSteps(app, o.hostname);
  if (o.list) {
    steps.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s.desc}`));
    return 0;
  }
  console.log(WARN(`target: ${target}`) + DIM("  (every step is idempotent; resume with --from N)"));
  for (const [i0, s] of steps.entries()) {
    const i = i0 + 1;
    if (i < o.from || (o.only && i !== o.only)) continue;
    console.log(`\n${BOLD(`[${i}/${steps.length}] ${s.desc}`)}`);
    const rc = (await s.run()) || 0;
    if (rc) {
      console.log(BAD(`step ${i} failed (rc=${rc}) → after fixing: m3 bootstrap ${target} --from ${i}`));
      return rc;
    }
  }
  console.log(OK("\nbootstrap complete"));
  return 0;
}
