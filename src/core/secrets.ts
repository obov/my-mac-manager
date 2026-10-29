// creds / env / backup / restore
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VaultItem } from "../types.js";
import { BAD, DIM, OK, WARN, ask, envKeys, fail, keyDiff, parseKv, rel, sha256, shq } from "../util.js";
import type { App } from "./app.js";

const itemName = (app: App): string => app.cfg.vault?.item ?? fail("[vault].item is required (item holding backup credentials and the login password)");

/** vault item → KEY=VALUE: KEY=VALUE lines in notes, fields (part after the last '>'), *.env attachments, aliases */
async function credKv(item: VaultItem, aliases: Record<string, string>, required: string[]) {
  const alias = (n: string) => aliases[n.toLowerCase()] ?? n;
  const kv = parseKv(item.notes);
  for (const f of item.fields) if (f.name && f.value) kv[alias(f.name.split(">").pop()!.trim())] = f.value.trim();
  for (const file of item.files ?? []) {
    if (file.name.endsWith(".env")) parseKv(await file.read(), kv);
    else {
      const a = alias(file.name);
      if ((a !== file.name || required.includes(file.name)) && !(a in kv)) kv[a] = (await file.read()).trim();
    }
  }
  const pk = aliases["@password"];
  if (pk && !(pk in kv) && item.password) kv[pk] = item.password;
  return kv;
}

const shape = (i: VaultItem) => [
  `type ${i.type ?? "?"}`,
  `password ${i.password ? "set" : "empty"}`,
  `notes ${i.notes ? i.notes.split("\n").length : 0} lines`,
  "fields " + (i.fields.map((f) => f.name).join(", ") || "none"),
  "attachments " + ((i.files ?? []).map((f) => f.name).join(", ") || "none"),
];

export async function cmdCreds(app: App, action: string) {
  if (!["check", "push"].includes(action)) fail("usage: m3 creds check|push");
  const b = app.backup();
  const { required, optional = [], aliases = {} } = b.credentials;
  const { kv, sh } = await app.withVault(async (v) => {
    const item = (await v.get(itemName(app))) ?? fail(BAD(`vault item '${itemName(app)}' not found`));
    return { kv: await credKv(item, aliases, required), sh: shape(item) };
  });
  console.log(DIM("  " + sh.join(" · ")));
  const keys = [...required, ...optional];
  for (const k of keys) console.log(`  ${k in kv ? OK("o") : BAD("x")} ${k}${required.includes(k) ? "" : DIM(" (optional)")}`);
  const other = Object.keys(kv).filter((k) => !keys.includes(k)).sort();
  if (other.length) console.log(DIM("  other keys: " + other.join(", ")));
  if (required.some((k) => !(k in kv)))
    fail(BAD("required values missing. Supported: KEY=VALUE lines in notes, fields, *.env attachments, aliases ([backup].aliases), item password (@password)"));
  if (action === "check") {
    const cmp = await b.compareCredentials(Object.fromEntries(keys.filter((k) => k in kv).map((k) => [k, kv[k]])));
    for (const k of keys.filter((x) => x in kv)) {
      const r = cmp[k];
      console.log(`  ${r === "same" ? OK("=") : WARN("≠")} ${k.padEnd(22)} ${r === "same" ? "same as target Mac" : r === "diff" ? "differs from target Mac" : "not on target Mac"}`);
    }
  } else {
    await b.writeCredentials(kv);
    console.log(OK(`written to ${app.remote.host}:~/${app.remote.credDir}`));
  }
  return 0;
}

// ---------- env (.env files ↔ vault) ----------
const ENV_REMOTE = String.raw`
import hashlib, json, os, sys
h = lambda v: hashlib.sha256(v.encode()).hexdigest()
def keys(t):
    out = {}
    for l in t.splitlines():
        l = l.strip()
        if l.startswith("export "): l = l[7:]
        if "=" in l and not l.startswith("#"):
            k, v = l.split("=", 1); out[k.strip()] = h(v.strip())
    return out
res = {}
for rel in json.loads(sys.argv[1]):
    f = os.path.join(os.path.expanduser("~"), rel)
    try:
        t = open(f).read()
    except OSError:
        res[rel] = None; continue
    res[rel] = {"sha": h(t), "keys": keys(t)}
    if sys.argv[2] == "1": res[rel]["content"] = t
print(json.dumps(res))
`;

function envFiles(app: App): [string, string][] {
  return [
    ...app.projects.flatMap((p) => (p.env ?? []).map((f: string) => [p.name, rel(f)] as [string, string])),
    ...(app.cfg.workspace?.env ?? []).map((f: string) => ["workspace", rel(f)] as [string, string]),
  ];
}

export async function cmdEnv(app: App, action: string, paths: string[], yes: boolean) {
  if (!["status", "push", "pull"].includes(action)) fail("usage: m3 env [status|push|pull] [path|project...]");
  const prefix: string = app.cfg.vault?.env_prefix ?? `${app.id} env: `;
  let files = envFiles(app);
  if (paths.length) files = files.filter(([n, r]) => paths.includes(r) || paths.includes(n));
  const rels = files.map(([, r]) => r);
  const R = app.remote;
  return app.withVault(async (v) => {
    await v.sync?.();
    if (app.cfg.vault?.item) await v.get(app.cfg.vault.item);   // rename the legacy item if present (legacy_item)
    const items = Object.fromEntries((await v.list(prefix)).map((i) => [i.name.slice(prefix.length), i]));
    const mac = JSON.parse((await R.python(ENV_REMOTE, [JSON.stringify(rels), action === "push" ? "1" : "0"]))!);
    const w = Math.max(12, ...files.map(([n]) => n.length)), wr = Math.max(34, ...rels.map((r) => r.length));
    if (action === "status") {
      console.log(DIM("  + only in vault · - only on target Mac · ~ value differs (key names only)"));
      for (const [n, r] of files) {
        const m = mac[r], it = items[r];
        const local = join(homedir(), r);
        const lk = existsSync(local) ? envKeys(readFileSync(local, "utf8")) : null;
        let st: string, ok = false;
        if (!it) st = WARN("not in vault → m3 env push");
        else if (!m) st = WARN("missing on target Mac → m3 env pull");
        else if (sha256(it.notes) === m.sha) { st = "vault = target Mac"; ok = true; }
        else st = WARN("differs " + keyDiff(m.keys, envKeys(it.notes)).join(" "));
        let here = "";
        if (lk && m) {
          const d = keyDiff(m.keys, lk);
          here = DIM("  this computer: " + (d.length ? "differs " + d.join(" ") : "same"));
        }
        console.log(`  ${ok ? OK("o") : BAD("x")} ${n.padEnd(w)} ${r.padEnd(wr)} ${st}${here}`);
      }
      return 0;
    }
    if (action === "push") {   // target Mac → vault
      const todo = files.filter(([, r]) => mac[r] && (!items[r] || sha256(items[r].notes) !== mac[r].sha));
      if (!todo.length) { console.log(OK("no changes")); return 0; }
      for (const [n, r] of todo)
        console.log(`  ${n.padEnd(w)} ${r.padEnd(wr)} ` + (!items[r] ? "new item" : "update " + keyDiff(envKeys(items[r].notes), mac[r].keys).join(" ")));
      if (!yes && (await ask("overwrite vault with target Mac contents (type push): ")) !== "push") { console.log("cancelled"); return 1; }
      for (const [, r] of todo) {
        await v.putNote(prefix + r, mac[r].content);
        console.log(OK(`  ${r} → vault`));
      }
      return 0;
    }
    // pull: vault → target Mac
    const todo = files.filter(([, r]) => items[r] && (!mac[r] || sha256(items[r].notes) !== mac[r].sha));
    const missing = rels.filter((r) => !items[r]);
    if (missing.length) console.log(WARN("not in vault (skipped): " + missing.join(", ")));
    if (!todo.length) { console.log(OK("no changes")); return 0; }
    for (const [n, r] of todo)
      console.log(`  ${n.padEnd(w)} ${r.padEnd(wr)} ` + (!mac[r] ? "new file" : "update " + keyDiff(mac[r].keys, envKeys(items[r].notes)).join(" ")));
    if (!yes && (await ask("overwrite target Mac files with vault contents (type pull): ")) !== "pull") { console.log("cancelled"); return 1; }
    for (const [n, r] of todo) {
      const q = shq(r);
      await R.run(`umask 077; mkdir -p "$(dirname ~/${q})" && cat > ~/${q}.m3-tmp && mv ~/${q}.m3-tmp ~/${q}`, { stdin: items[r].notes });
      console.log(OK(`  vault → ${r}`) + (n !== "workspace" ? DIM(`  apply: m3 restart ${n}`) : ""));
    }
    return 0;
  });
}

export async function cmdBackup(app: App, action = "snapshots") {
  if (!["now", "snapshots", "verify", "log"].includes(action)) fail("usage: m3 backup [now|snapshots|verify|log]");
  return app.backup().run(action as any);
}

export async function cmdRestore(app: App, what: string, name: string | undefined, target?: string) {
  if (!["secrets", "dirs", "data"].includes(what)) fail("usage: m3 restore secrets|dirs [--target DIR] | data <project>");
  if (what === "data" && !name) fail("usage: m3 restore data <project>");
  return app.backup().restore(what as any, { name, target });
}
