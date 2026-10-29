import type { Facts, Project, Row } from "../types.js";
import { BAD, DIM, OK, WARN, dur, fail, sleep } from "../util.js";
import type { App } from "./app.js";

export function rows(app: App, p: Project, f: Facts): Row[] {
  return app.services().flatMap(({ plugin, s }) =>
    s.check && s.keys.some((k) => k in p) ? s.check(app.ctx(plugin), p, f) : []);
}

export const allOk = (app: App, p: Project, f: Facts) => rows(app, p, f).every((r) => r.ok);
export const failing = (app: App, f: Facts) => app.projects.filter((p) => !allOk(app, p, f)).map((p) => p.name);

function kinds(app: App, p: Project) {
  const k = app.services().flatMap(({ s }) => (s.kinds && s.keys.some((x) => x in p) ? s.kinds(p) : []));
  if (p.daemon) k.push("daemon");
  if (p.gui) k.push("gui");
  return k.join(" ");
}

export function header(app: App, f: Facts) {
  const u = f.console_user;
  const login = u && u !== "root" ? OK(u) : WARN("none (affects gui projects only)");
  console.log(DIM(`${app.remote.host}  up ${dur(f.boot == null ? null : f.now - f.boot)}  `) + "GUI login: " + login);
}

export async function cmdLs(app: App) {
  const f = (await app.probe())!;
  header(app, f);
  console.log();
  const w = Math.max(0, ...app.projects.map((p) => p.name.length));
  for (const p of app.projects) {
    const ok = allOk(app, p, f);
    console.log(`  ${ok ? OK("OK  ") : BAD("FAIL")}  ${p.name.padEnd(w)}  ${kinds(app, p).padEnd(30)}  ${DIM(p.desc ?? "")}`);
  }
  const bad = failing(app, f);
  console.log(`\n${bad.length ? BAD("failing: " + bad.join(", ")) : OK("all OK")}`);
  return bad.length ? 1 : 0;
}

export async function cmdStatus(app: App, names: string[] = []) {
  const f = (await app.probe())!;
  header(app, f);
  const list = names.length ? names.map((n) => app.project(n)) : app.projects;
  for (const p of list) {
    const rs = rows(app, p, f);
    const ok = rs.every((r) => r.ok);
    console.log(`\n${ok ? OK("OK  ") : BAD("FAIL")} ${p.name}  ${DIM(p.desc ?? "")}`);
    if (p.clone) console.log(`     ${DIM(p.clone)}`);
    for (const r of rs) console.log(`     ${r.ok ? OK("o") : BAD("x")} ${(r.tag.padEnd(7) + " " + r.what).padEnd(46)} ${r.info}`);
  }
  const bad = list.filter((p) => !allOk(app, p, f)).map((p) => p.name);
  console.log(`\n${bad.length ? BAD("failing: " + bad.join(", ")) : OK("all OK")}`);
  return bad.length ? 1 : 0;
}

export async function cmdLogs(app: App, name: string, n: number) {
  const p = app.project(name);
  const lines = app.services().flatMap(({ plugin, s }) => (s.logs && s.keys.some((k) => k in p) ? s.logs(app.ctx(plugin), p, n) : []));
  if (!lines.length) fail(`${name}: nothing to show logs for`);
  return app.remote.script(lines.join("\n") + "\n");
}

export async function control(app: App, name: string, action: "start" | "stop" | "restart") {
  const p = app.project(name);
  const lines: string[] = [], tty: { label: string; cmd: string }[] = [];
  for (const { plugin, s } of app.services()) {
    if (!s.control || !s.keys.some((k) => k in p)) continue;
    const c = s.control(app.ctx(plugin), p, action);
    lines.push(...(c.lines ?? []));
    tty.push(...(c.tty ?? []));
  }
  if (!lines.length && !tty.length) fail(`${name}: nothing to control`);
  if (action === "stop") lines.reverse();
  let rc = 0;
  if (lines.length) rc = await app.remote.script("U=$(id -u)\n" + lines.join("\n") + "\n");
  for (const t of tty) {
    console.log(t.label);
    rc |= await app.remote.tty(t.cmd);
  }
  if (action === "stop") console.log(DIM("starts again on next boot (plist kept)"));
  await sleep(3000);
  await cmdStatus(app, [name]);
  return rc;
}

export async function cmdAudit(app: App) {
  const f = (await app.probe())!;
  let n = 0;
  const notes: string[] = [];
  for (const { plugin, s } of app.services()) {
    if (!s.audit) continue;
    for (const sec of s.audit(app.ctx(plugin), f)) {
      if (!sec.items.length) continue;
      if (sec.note) { notes.push(sec.title + sec.items.join(", ")); continue; }
      console.log(`\n${WARN(sec.title)}`);
      for (const i of sec.items) console.log(`  ${i}`);
      n += sec.items.length;
    }
  }
  if (notes.length) console.log("\n" + notes.map((x) => DIM(x)).join("\n"));
  const root: string | undefined = app.cfg.audit?.root;
  if (root) {
    const pre = root.replace(/\/$/, "") + "/";
    const first = (path?: string) => (path?.startsWith(pre) ? path.slice(pre.length).split("/")[0] : null);
    const used = new Set([
      ...[...app.projects, ...(app.cfg.workspace?.repos ?? [])].map((p: any) => first(p.clone)),
      ...(app.cfg.host?.dirs ?? []).map((d: string) => first(d)),
    ].filter(Boolean));
    const idle = f.dirs.filter((d) => !used.has(d));
    if (idle.length) console.log(DIM(`not referenced in m3.toml under ${root} (not reproducible): ${idle.join(", ")}`));
  }
  console.log(`\n${n ? WARN(`${n} to review`) : OK("nothing undeclared")}`);
  return n ? 1 : 0;
}
