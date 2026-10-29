// m3 plugin list|new|check, m3 init
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { BAD, DIM, OK, WARN, fail, shq } from "../util.js";
import { App, BUILTIN_SERVICES, BUILTIN_SLOTS, importPlugin, validatePlugin } from "./app.js";

export function cmdPluginList(app: App) {
  const slot = (p: any) => [p === app.vaultPlugin && "vault", p === app.backupPlugin && "backup"].filter(Boolean).join(",");
  for (const p of app.plugins) {
    const what = [
      slot(p) && `[${slot(p)}]`,
      p.services?.length && `service: ${p.services.map((s) => s.keys.join("/")).join(", ")}`,
      p.collectors?.length && `collector: ${p.collectors.map((c) => c.name).join(", ")}`,
      p.commands?.length && `command: ${p.commands.map((c) => c.name).join(", ")}`,
      p.hooks && `hook: ${Object.keys(p.hooks).join(", ")}`,
    ].filter(Boolean).join("  ");
    const src = [...BUILTIN_SERVICES, ...BUILTIN_SLOTS].includes(p) ? "builtin" : "external";
    console.log(`  ${p.name.padEnd(16)} ${DIM(src)}  ${what}  ${DIM(p.description ?? "")}`);
  }
  const avail = BUILTIN_SLOTS.filter((p) => !app.plugins.includes(p));
  if (avail.length) console.log(DIM(`\n  unused builtins: ${avail.map((p) => `${p.name}(${p.vault ? "vault" : "backup"})`).join(", ")}`));
  return 0;
}

/** validate given plugins (default: all configured) + project keys; --remote compiles collector code on the target Mac */
export async function cmdPluginCheck(app: App, specs: string[], remote: boolean) {
  let bad = 0;
  const targets = specs.length ? await Promise.all(specs.map((s) => importPlugin(s, app.root)))
    : app.plugins.filter((p) => !BUILTIN_SERVICES.includes(p) && !BUILTIN_SLOTS.includes(p));
  for (const p of targets) {
    const errs = validatePlugin(p);
    const ctx = app.ctx(p);
    for (const [k, fn] of [["remoteFiles", p.remoteFiles], ["agents", p.agents], ["bootstrap", p.bootstrap]] as const) {
      if (!fn) continue;
      try {
        const r = (fn as any)(ctx);
        if (!Array.isArray(r)) errs.push(`${k}(ctx): must return an array`);
        else if (k === "remoteFiles") r.forEach((f: any, i) => { if (typeof f?.name !== "string" || typeof f?.content !== "string" || f.name.includes("/")) errs.push(`remoteFiles[${i}]: { name (no path), content }`); });
        else if (k === "agents") r.forEach((a: any, i) => { if (typeof a?.label !== "string" || !String(a?.plist).includes("<plist")) errs.push(`agents[${i}]: { label, plist }`); });
        else r.forEach((s: any, i) => { if (!["before-projects", "finish"].includes(s?.phase) || typeof s?.run !== "function") errs.push(`bootstrap[${i}]: { desc, phase: before-projects|finish, run }`); });
      } catch (e: any) {
        errs.push(`${k}(ctx) threw: ${e.message}`);
      }
    }
    for (const k of ["vault", "backup"] as const) {
      if (!p[k]) continue;
      try {
        const inst: any = p[k]!(ctx);
        const need = k === "vault" ? ["get", "list", "putNote"]
          : ["writeCredentials", "compareCredentials", "hasCredentials", "run", "restore", "restoreDataCommand"];
        for (const m of need) if (typeof inst?.[m] !== "function") errs.push(`${k}(ctx).${m}: must be a function`);
        if (k === "backup" && !Array.isArray(inst?.credentials?.required)) errs.push("backup(ctx).credentials.required: must be an array of strings");
      } catch (e: any) {
        errs.push(`${k}(ctx) threw while creating: ${e.message}`);
      }
    }
    if (remote) for (const c of p.collectors ?? []) {
      const r = await app.remote.run(`/usr/bin/python3 -I -c ${shq("import sys;compile(sys.stdin.read(),'collector','exec')")}`, { stdin: c.code, check: false });
      if (r === null) errs.push(`collectors.${c.name}: does not compile with python3 on the target Mac (check 3.9 syntax / indentation)`);
    }
    console.log(`${errs.length ? BAD("x") : OK("o")} ${p.name}`);
    for (const e of errs) console.log(`    ${e}`);
    bad += errs.length;
  }
  const known = app.knownProjectKeys();
  for (const pr of app.projects) {
    const unknown = Object.keys(pr).filter((k) => k !== "name" && !known.has(k));
    if (unknown.length) { console.log(`${WARN("!")} projects.${pr.name}: keys no plugin handles: ${unknown.join(", ")}`); bad++; }
  }
  if (!bad) console.log(OK("no problems found"));
  return bad ? 1 : 0;
}

const TEMPLATES: Record<string, (name: string) => string> = {
  service: (n) => `// m3 plugin: ${n} (service). Spec: PLUGINS.md
// Adds a check row to projects that have a \`${n.replace(/-/g, "_")}\` key
/** @type {import("my-mac-manager/plugin").Plugin} */
export default {
  name: "${n}",
  apiVersion: 1,
  description: "",
  collectors: [{
    name: "${n.replace(/-/g, "_")}",
    // runs on the target Mac: python 3.9 standard library. sh(cmd), HOME, parse_ts available
    code: String.raw\`
def collect(arg, facts):
    return {"value": sh(["echo", "ok"]).strip()}
\`,
    arg: (ctx) => null,
  }],
  services: [{
    name: "${n}",
    keys: ["${n.replace(/-/g, "_")}"],
    check: (ctx, p, facts) => [
      { ok: facts.${n.replace(/-/g, "_")}?.value === "ok", tag: "${n.slice(0, 7)}", what: String(p.${n.replace(/-/g, "_")}), info: facts.${n.replace(/-/g, "_")}?.value ?? "missing" },
    ],
  }],
};
`,
  vault: (n) => `// m3 plugin: ${n} (vault). Spec: PLUGINS.md
// m3.toml: [vault] use = "./plugins/${n}.mjs", item = "..."
import { spawnSync } from "node:child_process";

/** @type {import("my-mac-manager/plugin").Plugin} */
export default {
  name: "${n}",
  apiVersion: 1,
  description: "",
  vault: (ctx) => ({
    async open() {},            // unlock / log in (interactive input: stdio "inherit")
    async close() {},           // end the session
    async get(name) {           // exactly one matching item → { name, notes, password, fields: [{name, value}], files: [{name, read}] } | null
      return null;
    },
    async list(prefix) {        // items whose name starts with prefix (including notes)
      return [];
    },
    async putNote(name, content) {   // create a secure note or replace its notes
      throw new Error("not implemented");
    },
  }),
};
`,
  backup: (n) => `// m3 plugin: ${n} (backup). Spec: PLUGINS.md
// m3.toml: [backup] use = "./plugins/${n}.mjs"
/** @type {import("my-mac-manager/plugin").Plugin} */
export default {
  name: "${n}",
  apiVersion: 1,
  description: "",
  backup: (ctx) => ({
    credentials: { required: [], optional: [], aliases: {} },
    async writeCredentials(kv) {},                 // kv → target Mac ~/\${ctx.remote.credDir}
    async compareCredentials(kv) { return {}; },   // key → "same" | "diff" | "none" (compare hashes)
    async hasCredentials() { return true; },
    async run(action) { return 0; },               // now | snapshots | verify | log
    async restore(what, o) { return 0; },          // secrets | dirs | data (o.name)
    restoreDataCommand(name) { return "true"; },   // shell command the target Mac runs during bootstrap
    // ctx.backupPlan(): { secrets, dirs, dirs_exclude, data } (paths relative to $HOME)
  }),
};
`,
  command: (n) => `// m3 plugin: ${n} (command). Spec: PLUGINS.md
/** @type {import("my-mac-manager/plugin").Plugin} */
export default {
  name: "${n}",
  apiVersion: 1,
  description: "",
  commands: [{
    name: "${n}",
    summary: "",
    usage: "m3 ${n} [--yes]",
    options: { yes: { type: "boolean" } },
    async run(ctx, { values, positionals }) {
      const out = await ctx.remote.run("uptime");
      console.log(out.trim());
      return 0;
    },
  }],
};
`,
};

export function cmdPluginNew(root: string, name: string, kind: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail("name: lowercase letters, digits and -");
  if (!TEMPLATES[kind]) fail(`kind: ${Object.keys(TEMPLATES).join(" | ")}`);
  const dir = join(root, "plugins"), f = join(dir, `${name}.mjs`);
  if (existsSync(f)) fail(`already exists: ${f}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, TEMPLATES[kind](name));
  const spec = "./" + relative(root, f);
  console.log(OK(`created: ${f}`));
  console.log(kind === "vault" || kind === "backup" ? `m3.toml: [${kind}] use = "${spec}"` : `m3.toml: plugins = ["${spec}"]`);
  console.log(DIM("validate: m3 plugin check " + spec));
  return 0;
}

export function cmdInit(dir: string, host: string) {
  const f = resolve(dir, "m3.toml");
  if (existsSync(f)) fail(`already exists: ${f}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, `# m3 config. Keys: see README.md

[host]
ssh = "${host}"                 # host from ~/.ssh/config
# hostname = "my-mac"           # set by m3 host apply
# vnc_host = "100.x.y.z"        # address for m3 login (Screen Sharing)
# screen_sharing = "vnc://my-mac.local"
secrets = ["~/.ssh/id_ed25519", "~/.ssh/config", "~/.gitconfig"]
dirs = []
# brewfile = "host/Brewfile"
# tools = "host/tools.sh"
# settings = "host/settings.sh"  # extra check / note lines for host-settings.sh
# launchd = ["launchd"]          # plist files / dirs to deploy

# [vault]
# use = "bitwarden"
# item = "m3 > my-mac"           # item with backup credentials and the Mac login password

# [backup]
# use = "restic"
# optional = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]

# plugins = ["./plugins/example.mjs"]

[projects.example]
desc = "example: launchd service"
launchd = ["com.example.agent"]
ports = [8080]
`);
  console.log(OK(`created: ${f}`));
  return 0;
}
