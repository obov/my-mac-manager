import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { App, findConfig } from "./core/app.js";
import { cmdPluginCheck, cmdPluginList, cmdPluginNew, cmdInit } from "./core/plugincmd.js";
import { cmdLogin, cmdReboot, cmdUnlock, cmdWait } from "./core/power.js";
import { cmdBackup, cmdCreds, cmdEnv, cmdRestore } from "./core/secrets.js";
import { cmdBootstrap, cmdHost, cmdInstall } from "./core/setup.js";
import { cmdAudit, cmdLogs, cmdLs, cmdStatus, control } from "./core/status.js";
import type { Command } from "./types.js";
import { BOLD, DIM, fail } from "./util.js";

type Opts = NonNullable<Command["options"]>;
interface Core { usage: string; summary: string; options?: Opts; noConfig?: boolean; run(app: App | null, v: any, pos: string[]): Promise<number | void> }

const CORE: Record<string, Core> = {
  ls: { usage: "m3 [ls]", summary: "one-line status per project", run: (a) => cmdLs(a!) },
  status: { usage: "m3 status [project...]", summary: "detailed status per service", run: (a, _v, p) => cmdStatus(a!, p) },
  logs: { usage: "m3 logs <project> [-n 50]", summary: "launchd / compose logs", options: { lines: { type: "string", short: "n", default: "50" } },
    run: (a, v, p) => cmdLogs(a!, need(p[0], "project"), Number(v.lines)) },
  start: { usage: "m3 start <project>", summary: "start (gui / system domain detected)", run: (a, _v, p) => control(a!, need(p[0], "project"), "start") },
  stop: { usage: "m3 stop <project>", summary: "stop", run: (a, _v, p) => control(a!, need(p[0], "project"), "stop") },
  restart: { usage: "m3 restart <project>", summary: "restart", run: (a, _v, p) => control(a!, need(p[0], "project"), "restart") },
  audit: { usage: "m3 audit", summary: "launchd jobs, containers, ports, orphan processes not in m3.toml", run: (a) => cmdAudit(a!) },
  reboot: { usage: "m3 reboot [--yes] [--manual]", summary: "check → FileVault authrestart → wait → GUI login → status",
    options: { yes: { type: "boolean" }, manual: { type: "boolean" } }, run: (a, v) => cmdReboot(a!, !!v.yes, !!v.manual) },
  unlock: { usage: "m3 unlock", summary: "unlock FileVault over SSH after an unplanned reboot → wait", run: (a) => cmdUnlock(a!) },
  wait: { usage: "m3 wait", summary: "wait for SSH and services after a reboot", run: (a) => cmdWait(a!) },
  login: { usage: "m3 login", summary: "GUI login (types the vault password into the login window over Screen Sharing)", run: (a) => cmdLogin(a!) },
  install: { usage: "m3 install", summary: "deploy remote scripts, config and launchd plists, then load them", run: (a) => cmdInstall(a!) },
  host: { usage: "m3 host plan|apply", summary: "host settings (pmset, ssh, screen sharing, updates, sudoers): check / apply",
    run: (a, _v, p) => cmdHost(a!, p[0] ?? "plan") },
  creds: { usage: "m3 creds check|push", summary: "backup credentials: vault → target Mac", run: (a, _v, p) => cmdCreds(a!, p[0] ?? "check") },
  env: { usage: "m3 env [status|push|pull] [path|project...] [--yes]", summary: ".env files ↔ vault secure notes (vault is the source of truth)",
    options: { yes: { type: "boolean" } }, run: (a, v, p) => cmdEnv(a!, p[0] ?? "status", p.slice(1), !!v.yes) },
  backup: { usage: "m3 backup [now|snapshots|verify|log]", summary: "backup", run: (a, _v, p) => cmdBackup(a!, p[0]) },
  restore: { usage: "m3 restore secrets|dirs [--target DIR] | data <project>", summary: "restore from backup", options: { target: { type: "string" } },
    run: (a, v, p) => cmdRestore(a!, need(p[0], "target"), p[1], v.target) },
  bootstrap: { usage: "m3 bootstrap <ssh-host> [--from N] [--only N] [--list] [--hostname H]", summary: "rebuild everything on a new Mac",
    options: { from: { type: "string", default: "1" }, only: { type: "string" }, list: { type: "boolean" }, hostname: { type: "string" } },
    run: (a, v, p) => cmdBootstrap(a!, need(p[0], "ssh-host"), { from: Number(v.from), only: v.only ? Number(v.only) : undefined, list: !!v.list, hostname: v.hostname }) },
  plugin: { usage: "m3 plugin list | new <name> [--kind service|vault|backup|command] | check [plugin...] [--remote]",
    summary: "list, scaffold and validate plugins", options: { kind: { type: "string", default: "service" }, remote: { type: "boolean" } },
    run: async (a, v, p) => {
      const sub = p[0] ?? "list";
      if (sub === "list") return cmdPluginList(a!);
      if (sub === "new") return cmdPluginNew(a!.root, need(p[1], "name"), v.kind);
      if (sub === "check") return cmdPluginCheck(a!, p.slice(1), !!v.remote);
      fail("usage: " + CORE.plugin.usage);
    } },
  init: { usage: "m3 init [dir] --host <ssh-host>", summary: "create m3.toml", noConfig: true, options: { host: { type: "string" } },
    run: async (_a, v, p) => cmdInit(p[0] ?? ".", v.host ?? "my-mac") },
};

function need(v: string | undefined, what: string): string {
  return v ?? fail(`${what} required`);
}

/** terminal display width (CJK = 2 columns) */
const width = (s: string) => [...s].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/.test(ch) ? 2 : 1), 0);

function version() {
  let v = "?";
  try {
    v = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {}
  // running from a source checkout (not an npm install) → show where
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  return root.split("/").includes("node_modules") ? v : `${v} (dev: ${root})`;
}

function help(app: App | null, configPath: string | null) {
  const rows: [string, string][] = Object.values(CORE).map((c) => [c.usage, c.summary]);
  const ext = app ? app.commands().map(({ plugin, c }) => [c.usage ?? `m3 ${c.name}`, `${c.summary}  ${DIM(`(${plugin.name})`)}`] as [string, string]) : [];
  const w = Math.min(44, Math.max(...[...rows, ...ext].map(([u]) => width(u))));
  const line = (u: string, s: string) => console.log(width(u) > w ? `  ${u}\n  ${" ".repeat(w)}  ${DIM(s)}` : `  ${u}${" ".repeat(w - width(u))}  ${DIM(s)}`);
  console.log(`${BOLD("m3")} ${version()}: remote Mac management (my-mac-manager)\n`);
  for (const [u, s] of rows) line(u, s);
  if (ext.length) {
    console.log("\nPlugin commands");
    for (const [u, s] of ext) line(u, s);
  }
  console.log(`\nGlobal options: --host <ssh-host>  --config <m3.toml>`);
  console.log(DIM(`config: ${configPath ?? "none (m3 init, or ./m3.toml, $M3_CONFIG, ~/.config/m3/m3.toml)"}`));
}

async function main() {
  const argv = process.argv.slice(2);
  const g: { host?: string; config?: string } = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--host" || a === "--config") && rest.length === 0) g[a.slice(2) as "host" | "config"] = argv[++i];
    else rest.push(a);
  }
  if (rest[0] === "--version" || rest[0] === "-v") return console.log(version());
  const cmd = rest[0] && !rest[0].startsWith("-") ? rest[0] : "ls";
  const args = rest[0] && !rest[0].startsWith("-") ? rest.slice(1) : rest;
  const path = findConfig(g.config);
  const core = CORE[cmd];

  if (core?.noConfig) {
    const { values, positionals } = parseArgs({ args, options: core.options ?? {}, allowPositionals: true });
    process.exit((await core.run(null, values, positionals)) || 0);
  }
  if (!path) {
    if (cmd === "help" || args.includes("-h") || args.includes("--help") || rest[0] === "-h" || rest[0] === "--help") return help(null, null);
    fail("no m3.toml → m3 init --host <ssh-host>  (searched: --config, $M3_CONFIG, current and parent dirs, ~/.config/m3/m3.toml)");
  }
  const app = new App(path, g.host);
  await app.load();
  app.status = (names) => cmdStatus(app, names ?? []);
  const ext = new Map(app.commands().map(({ plugin, c }) => [c.name, { plugin, c }]));
  for (const n of ext.keys()) if (CORE[n] || n === "help") fail(`plugin command conflicts with a built-in command: ${n} (${ext.get(n)!.plugin.name})`);
  if (cmd === "help" || rest[0] === "-h" || rest[0] === "--help") return help(app, path);

  const spec = core?.options ?? ext.get(cmd)?.c.options ?? {};
  let parsed;
  try {
    parsed = parseArgs({ args, options: { ...spec, help: { type: "boolean", short: "h" } } as any, allowPositionals: true });
  } catch (e: any) {
    fail(e.message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(core?.usage ?? ext.get(cmd)?.c.usage ?? `m3 ${cmd}`);
    return;
  }
  let rc: number | void;
  if (core) rc = await core.run(app, values, positionals);
  else if (ext.has(cmd)) {
    const { plugin, c } = ext.get(cmd)!;
    rc = await c.run(app.ctx(plugin), { values, positionals });
  } else fail(`unknown command: ${cmd} → m3 help`);
  process.exit(rc || 0);
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(1);
});
