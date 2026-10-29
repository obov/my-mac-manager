// reboot / unlock / wait / login
import { exec } from "../remote.js";
import { BAD, DIM, OK, WARN, ask, fail, poll, sleep } from "../util.js";
import { vncLogin } from "../vnc.js";
import type { App } from "./app.js";
import { cmdLs, failing, header, rows } from "./status.js";

async function bootedSince(app: App, old: number | null) {
  const out = await app.remote.run("sysctl -n kern.boottime", { check: false, timeout: 15 });
  const m = out?.match(/sec = (\d+)/);
  if (!m) return null;
  const b = Number(m[1]);
  return old == null || b !== old ? b : null;
}

async function consoleUser(app: App) {
  return ((await app.remote.run("stat -f %Su /dev/console", { check: false, timeout: 15 })) ?? "").trim();
}

/** Mac login password from the vault item: field [vault].login_password_field (default password), else the item password */
export async function macPassword(app: App): Promise<string | undefined> {
  const field = String(app.cfg.vault?.login_password_field ?? "password").toLowerCase();
  return app.withVault(async (v) => {
    const item = await v.get(app.cfg.vault?.item) ?? fail(BAD(`vault item '${app.cfg.vault?.item}' not found`));
    const f = item.fields.find((x) => x.name.split(">").pop()!.trim().toLowerCase() === field && x.value);
    return f?.value ?? item.password;
  });
}

export async function cmdWait(app: App, oldBoot: number | null = null, pw?: string) {
  if (!(await poll("SSH back (boot complete)", () => bootedSince(app, oldBoot), { timeout: 900 }))) {
    console.log("possibly waiting at the FileVault unlock screen → m3 unlock");
    return 2;
  }
  let d = "";
  const healthy = async () => {
    const f = await app.probe({ check: false });
    if (!f) { d = "probe failed"; return null; }
    const parts: string[] = [];
    for (const n of failing(app, f)) {
      const p = app.project(n);
      if (p.gui) continue;
      const bad = rows(app, p, f).filter((r) => !r.ok).map((r) => r.what.split(" ").pop() + (r.info ? ` ${r.info}` : ""));
      parts.push(`${n}: ${bad.join("; ")}`);
    }
    d = parts.join(" | ");
    return !parts.length;
  };
  if (!(await poll("server services OK (gui projects excluded)", healthy, { timeout: 600, every: 15, detail: () => d, stall: 240 })))
    console.log(DIM("  next: m3 status <project> for details → m3 restart <project>"));
  const gui = app.projects.filter((p) => p.gui).map((p) => p.name);
  if (gui.length && ["", "root"].includes(await consoleUser(app))) {
    if (pw) await cmdLogin(app, pw);
    else console.log(WARN("no GUI login → gui projects not started. m3 login (automatic, over Screen Sharing) or log in manually via " + (app.cfg.host.screen_sharing ?? "Screen Sharing")));
  }
  if (gui.length && !["", "root"].includes(await consoleUser(app))) {
    const guiOk = async () => {
      const f = await app.probe({ check: false });
      if (!f) return null;
      const bad = failing(app, f).filter((n) => gui.includes(n));
      d = bad.join(", ");
      return !bad.length;
    };
    await poll("gui projects OK", guiOk, { timeout: 300, every: 15, detail: () => d });
  }
  console.log();
  return cmdLs(app);
}

export async function cmdLogin(app: App, pw?: string) {
  const user = ((await app.remote.run("id -un", { check: false })) ?? "").trim();
  const cur = await consoleUser(app);
  if (cur && cur !== "root") { console.log(OK(`already logged in: ${cur}`)); return 0; }
  pw = pw ?? (await macPassword(app));
  if (!pw) fail(BAD(`no login password in vault item '${app.cfg.vault?.item}'`));
  const host = app.cfg.host.vnc_host ?? app.remote.host;
  console.log(`Screen Sharing login: ${user}@${host}`);
  try {
    await vncLogin(host, user, pw);
  } catch (e: any) {
    fail(BAD(`VNC connection / input failed: ${e.message}`));
  }
  const ok = await poll("GUI login", async () => { const u = await consoleUser(app); return u && u !== "root" ? u : null; }, { timeout: 60, every: 5 });
  if (!ok) {
    console.log(BAD(`not logged in. Wrong password or the login window shows a user list → check via ${app.cfg.host.screen_sharing ?? "Screen Sharing"}`));
    return 1;
  }
  return 0;
}

export async function cmdUnlock(app: App) {
  console.log("FileVault unlock over SSH: enter the password; the connection dropping afterwards is expected (boot continues)");
  console.log(DIM("if the Mac is already booted you get a normal shell → exit"));
  await app.remote.ssh(["-o", "ConnectTimeout=10", "-o", "PubkeyAuthentication=no", "-t", app.remote.host]);
  await sleep(10000);
  return cmdWait(app);
}

export async function cmdReboot(app: App, yes: boolean, manual: boolean) {
  const f = (await app.probe())!;
  header(app, f);
  const bad = failing(app, f);
  console.log(`failing before reboot: ${bad.length ? BAD(bad.join(", ")) : OK("none")}`);
  for (const p of app.plugins) {
    const lines = p.hooks?.beforeReboot ? await p.hooks.beforeReboot(app.ctx(p), f) : [];
    if (lines.length) console.log("\n" + lines.join("\n"));
  }
  const user = ((await app.remote.run("id -un", { check: false })) ?? "").trim();
  console.log(DIM("\nflow: sudo fdesetup authrestart (one-time FileVault unlock) → check services → GUI login (Screen Sharing) → check gui projects"));
  console.log(DIM(`  ${user} login password: ` + (manual ? "typed 3 times (sudo, user name, password)"
    : `from vault item '${app.cfg.vault?.item}' (one vault unlock)`)));
  if (!yes && (await ask("\ntype reboot to continue: ")) !== "reboot") { console.log("cancelled"); return 1; }
  let pw: string | undefined, rc: number;
  if (manual) {
    rc = await app.remote.tty("sudo fdesetup authrestart -delayminutes 0");
  } else {
    pw = await macPassword(app);
    if (!pw) fail(BAD("no login password in vault → m3 reboot --manual"));
    const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const plist = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
      `<key>Username</key><string>${esc(user)}</string><key>Password</key><string>${esc(pw)}</string></dict></plist>`;
    // sudo -S reads the first line (password), fdesetup -inputplist reads the rest from stdin. Values only travel inside ssh
    rc = (await exec("ssh", ["-o", "ConnectTimeout=8", app.remote.host, "sudo -S -p '' fdesetup authrestart -delayminutes 0 -inputplist"],
      { stdin: pw + "\n" + plist + "\n", live: true })).code;
  }
  if (rc !== 0 && rc !== 255) {  // 255: connection dropped by the reboot
    console.log(BAD(`authrestart failed (rc=${rc}). Not rebooting` + (manual ? "" : " (wrong password? → m3 reboot --manual)")));
    return rc;
  }
  console.log("rebooting. Waiting for it to come back\n");
  await sleep(20000);
  return cmdWait(app, f.boot, pw);
}

