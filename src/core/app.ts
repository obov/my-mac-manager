import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "smol-toml";
import PROBE_PY from "../assets/probe.py";
import bitwarden from "../builtin/bitwarden.js";
import launchd from "../builtin/launchd.js";
import restic from "../builtin/restic.js";
import { apps, compose, docker, heartbeat, logscan, ports } from "../builtin/services.js";
import { SshRemote } from "../remote.js";
import type { Backup, BackupPlan, Collector, Command, Context, Dict, Facts, Plugin, Project, Service, UI, Vault } from "../types.js";
import { BAD, BOLD, DIM, OK, WARN, ask, dur, fail, poll, rel } from "../util.js";

/** service check order = this order (row order in status) */
export const BUILTIN_SERVICES: Plugin[] = [launchd, docker, compose, apps, heartbeat, logscan, ports];
export const BUILTIN_SLOTS: Plugin[] = [bitwarden, restic];
export const CORE_PROJECT_KEYS = ["desc", "repo", "clone", "gui", "daemon", "secrets", "env", "dirs", "data_backup", "data_restore", "setup"];

export const ui: UI = { ok: OK, bad: BAD, warn: WARN, dim: DIM, bold: BOLD, dur, ask, poll };

export function findConfig(explicit?: string): string | null {
  if (explicit) return resolve(explicit);
  if (process.env.M3_CONFIG) return resolve(process.env.M3_CONFIG);
  for (let d = process.cwd(); ; d = dirname(d)) {
    if (existsSync(join(d, "m3.toml"))) return join(d, "m3.toml");
    if (dirname(d) === d) break;
  }
  const g = join(homedir(), ".config/m3/m3.toml");
  return existsSync(g) ? g : null;
}

// ---------- plugin loading ----------
function pkgEntry(dir: string): string {
  const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const ex = pj.exports;
  const pick = (e: any): string | undefined =>
    typeof e === "string" ? e : e && typeof e === "object" ? pick(e["."] ?? e.import ?? e.default ?? e.node) : undefined;
  return join(dir, pick(ex) ?? pj.module ?? pj.main ?? "index.js");
}

/** find a package directory walking up node_modules */
function findPackage(name: string, from: string): string | null {
  for (let d = from; ; d = dirname(d)) {
    const p = join(d, "node_modules", name);
    if (existsSync(join(p, "package.json"))) return p;
    if (dirname(d) === d) return null;
  }
}

export async function importPlugin(spec: string, root: string): Promise<Plugin> {
  const builtin = [...BUILTIN_SERVICES, ...BUILTIN_SLOTS].find((p) => p.name === spec);
  if (builtin) return builtin;
  let file: string | null = null;
  if (/^[.~/]/.test(spec)) {
    file = resolve(root, spec.startsWith("~/") ? join(homedir(), spec.slice(2)) : spec);
    if (!existsSync(file)) fail(`plugin file not found: ${file}`);
  } else {
    const names = spec.startsWith("@") || spec.startsWith("m3-plugin-") ? [spec] : [`m3-plugin-${spec}`, spec];
    const bases = [root, dirname(fileURLToPath(import.meta.url))];
    for (const b of bases) for (const n of names) {
      const dir = file ? null : findPackage(n, b);
      if (dir) file = pkgEntry(dir);
    }
    if (!file) fail(`plugin package not found: ${names.join(" or ")} → npm i ${names[0]} in ${root} (or npm i -g)`);
  }
  const mod = await import(pathToFileURL(file).href);
  let p = mod.default ?? mod.plugin;
  if (typeof p === "function") p = await p();
  const errs = validatePlugin(p);
  if (errs.length) fail(`invalid plugin (${spec}):\n  - ` + errs.join("\n  - "));
  return p;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** validate a plugin object → list of errors (used by m3 plugin check and on load) */
export function validatePlugin(p: any): string[] {
  const e: string[] = [];
  if (!p || typeof p !== "object") return ["default export is not a plugin object"];
  if (typeof p.name !== "string" || !NAME.test(p.name)) e.push(`name: lowercase letters, digits and - only (${p.name})`);
  if (p.apiVersion != null && p.apiVersion !== 1) e.push(`apiVersion: only 1 is supported (${p.apiVersion})`);
  for (const k of ["vault", "backup", "remoteFiles", "agents", "bootstrap"])
    if (p[k] != null && typeof p[k] !== "function") e.push(`${k}: must be a function (ctx) => ...`);
  const arr = (k: string) => p[k] == null || Array.isArray(p[k]) || (e.push(`${k}: must be an array`), false);
  if (arr("services")) for (const [i, s] of (p.services ?? []).entries()) {
    if (typeof s?.name !== "string") e.push(`services[${i}].name missing`);
    if (!Array.isArray(s?.keys) || !s.keys.length || s.keys.some((k: any) => typeof k !== "string")) e.push(`services[${i}].keys: non-empty array of strings`);
    for (const f of ["check", "kinds", "control", "logs", "audit"]) if (s?.[f] != null && typeof s[f] !== "function") e.push(`services[${i}].${f}: must be a function`);
  }
  if (arr("collectors")) for (const [i, c] of (p.collectors ?? []).entries()) {
    if (typeof c?.name !== "string" || !/^[a-z_][a-z0-9_]*$/.test(c.name)) e.push(`collectors[${i}].name: lowercase letters, digits and _ (${c?.name})`);
    else if (["now", "boot", "console_user", "procs", "ports", "dirs"].includes(c.name)) e.push(`collectors[${i}].name: conflicts with a built-in fact (${c.name})`);
    if (typeof c?.code !== "string" || !/^def collect\(/m.test(c.code)) e.push(`collectors[${i}].code: must define 'def collect(arg, facts):'`);
    if (c?.arg != null && typeof c.arg !== "function") e.push(`collectors[${i}].arg: must be a function`);
  }
  if (arr("commands")) for (const [i, c] of (p.commands ?? []).entries()) {
    if (typeof c?.name !== "string" || !NAME.test(c.name)) e.push(`commands[${i}].name: lowercase letters, digits and -`);
    if (typeof c?.run !== "function") e.push(`commands[${i}].run: must be a function`);
    if (typeof c?.summary !== "string") e.push(`commands[${i}].summary missing`);
  }
  if (p.hooks != null && typeof p.hooks !== "object") e.push("hooks: must be an object");
  if (p.hooks?.beforeReboot != null && typeof p.hooks.beforeReboot !== "function") e.push("hooks.beforeReboot: must be a function");
  if (p.projectKeys != null && (!Array.isArray(p.projectKeys) || p.projectKeys.some((k: any) => typeof k !== "string"))) e.push("projectKeys: array of strings");
  return e;
}

// ---------- app ----------
export class App {
  cfg: Dict;
  root: string;
  id: string;
  remote: SshRemote;
  projects: Project[];
  plugins: Plugin[] = [];
  vaultPlugin?: Plugin;
  backupPlugin?: Plugin;
  private backupInst?: Backup;
  status!: (names?: string[]) => Promise<number>;

  constructor(public path: string, hostOverride?: string) {
    try {
      this.cfg = parse(readFileSync(path, "utf8")) as Dict;
    } catch (e: any) {
      fail(`${path}: ${e.message}`);
    }
    this.root = dirname(path);
    if (!this.cfg.host?.ssh) fail(`${path}: [host].ssh is required`);
    for (const [k, v] of Object.entries(this.cfg))
      if (k !== "plugin" && v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as Dict).plugins))
        fail(`${path}: plugins ended up inside the [${k}] table → move it to the top of the file (before the first [table])`);
    this.id = this.cfg.remote?.id ?? "m3";
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(this.id)) fail(`[remote].id: lowercase letters, digits, . and - (${this.id})`);
    this.remote = new SshRemote(hostOverride ?? this.cfg.host.ssh, this.id);
    this.projects = Object.entries(this.cfg.projects ?? {}).map(([name, p]) => ({ ...(p as Dict), name }));
  }

  async load() {
    this.plugins = [...BUILTIN_SERVICES];
    for (const spec of this.cfg.plugins ?? []) this.plugins.push(await importPlugin(spec, this.root));
    const slot = async (key: "vault" | "backup") => {
      const use = this.cfg[key]?.use;
      if (!use) return undefined;
      const p = this.plugins.find((x) => x.name === use) ?? (await importPlugin(use, this.root));
      if (!p[key]) fail(`[${key}].use = "${use}": plugin does not provide ${key}`);
      if (!this.plugins.includes(p)) this.plugins.push(p);
      return p;
    };
    this.vaultPlugin = await slot("vault");
    this.backupPlugin = await slot("backup");
    const names = new Set<string>();
    for (const p of this.plugins) {
      if (names.has(p.name)) fail(`duplicate plugin name: ${p.name}`);
      names.add(p.name);
    }
    const seen = new Set<string>();
    for (const c of this.collectors()) {
      if (seen.has(c.c.name)) fail(`duplicate collector name: ${c.c.name} (${c.plugin.name})`);
      seen.add(c.c.name);
    }
  }

  options(p: Plugin): Dict {
    const strip = (o: Dict | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => k !== "use"));
    if (p === this.vaultPlugin) return strip(this.cfg.vault);
    if (p === this.backupPlugin) return strip(this.cfg.backup);
    return this.cfg.plugin?.[p.name] ?? {};
  }

  ctx(p?: Plugin): Context {
    return {
      config: this.cfg, root: this.root, id: this.id, options: p ? this.options(p) : {}, projects: this.projects,
      remote: this.remote, ui,
      probe: (o) => this.probe(o),
      withVault: (fn) => this.withVault(fn),
      backup: () => this.backup(),
      backupPlan: () => this.backupPlan(),
      status: (names) => this.status(names),
      fail,
    };
  }

  services(): { plugin: Plugin; s: Service }[] {
    return this.plugins.flatMap((plugin) => (plugin.services ?? []).map((s) => ({ plugin, s })));
  }

  collectors(): { plugin: Plugin; c: Collector }[] {
    return this.plugins.flatMap((plugin) => (plugin.collectors ?? []).map((c) => ({ plugin, c })));
  }

  commands(): { plugin: Plugin; c: Command }[] {
    return this.plugins.flatMap((plugin) => (plugin.commands ?? []).map((c) => ({ plugin, c })));
  }

  knownProjectKeys(): Set<string> {
    return new Set([...CORE_PROJECT_KEYS, ...this.plugins.flatMap((p) => [...(p.projectKeys ?? []), ...(p.services ?? []).flatMap((s) => s.keys)])]);
  }

  project(name: string): Project {
    return this.projects.find((p) => p.name === name) ?? fail(`no such project: ${name}\nprojects: ${this.projects.map((p) => p.name).join(", ")}`);
  }

  async probe(o: { check?: boolean } = {}): Promise<Facts | null> {
    const frags: [string, string, unknown][] = [];
    for (const { plugin, c } of this.collectors()) frags.push([c.name, c.code, c.arg ? await c.arg(this.ctx(plugin)) : null]);
    const b64 = Buffer.from(JSON.stringify(frags)).toString("base64");
    const script = PROBE_PY + `\nmain(${JSON.stringify(b64)}, ${JSON.stringify(this.cfg.audit?.root ?? "")})\n`;
    const out = await this.remote.python(script, [], { check: o.check ?? true, timeout: 90 });
    if (!out) return null;
    const f = JSON.parse(out) as Facts;
    for (const [n, m] of Object.entries(f._errors ?? {})) console.error(WARN(`collector ${n} failed: ${m}`));
    return f;
  }

  async withVault<T>(fn: (v: Vault) => Promise<T>): Promise<T> {
    if (!this.vaultPlugin) fail("no vault configured → m3.toml [vault] use = \"bitwarden\" (or another plugin)");
    const v = this.vaultPlugin.vault!(this.ctx(this.vaultPlugin));
    await v.open?.();
    try {
      return await fn(v);
    } finally {
      await v.close?.();
    }
  }

  backup(): Backup {
    if (!this.backupPlugin) fail("no backup configured → m3.toml [backup] use = \"restic\" (or another plugin)");
    return (this.backupInst ??= this.backupPlugin.backup!(this.ctx(this.backupPlugin)));
  }

  backupPlan(): BackupPlan {
    const H = this.cfg.host ?? {}, W = this.cfg.workspace ?? {};
    const secrets = [...(H.secrets ?? []), ...(W.secrets ?? [])], dirs = [...(H.dirs ?? [])];
    const data: BackupPlan["data"] = {};
    for (const p of this.projects) {
      secrets.push(...(p.secrets ?? []));
      dirs.push(...(p.dirs ?? []));
      if (p.data_backup) data[p.name] = { backup: p.data_backup, restore: p.data_restore ?? "" };
    }
    return { secrets: secrets.map(rel), dirs: dirs.map(rel), dirs_exclude: H.dirs_exclude ?? [], data };
  }
}
