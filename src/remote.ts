import { spawn } from "node:child_process";
import type { Remote, RunOptions } from "./types.js";
import { fail, shq } from "./util.js";

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }

/** live: stream stdout/stderr, tty: attach stdin/stdout/stderr to the terminal */
export function exec(cmd: string, args: string[], o: { stdin?: string; timeout?: number; live?: boolean; tty?: boolean } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const stdio: any = o.tty ? "inherit"
      : [o.stdin != null ? "pipe" : "ignore", o.live ? "inherit" : "pipe", o.live ? "inherit" : "pipe"];
    const p = spawn(cmd, args, { stdio });
    let stdout = "", stderr = "", timedOut = false, done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    p.stdout?.setEncoding("utf8").on("data", (d) => (stdout += d));
    p.stderr?.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = o.timeout ? setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, o.timeout * 1000) : null;
    p.on("error", (e) => { stderr += String(e); finish(127); });
    p.on("close", (code, sig) => finish(code ?? (sig ? 128 : 1)));
    if (o.stdin != null && p.stdin) {
      p.stdin.on("error", () => {});
      p.stdin.end(o.stdin);
    }
  });
}

export class SshRemote implements Remote {
  constructor(public host: string, public id: string) {}
  get dir() { return `.local/share/${this.id}`; }
  get credDir() { return `.config/${this.id}`; }
  get helper() { return `/usr/local/libexec/${this.id}-launchd`; }

  async run(cmd: string, o: RunOptions = {}) {
    const check = o.check ?? true;
    const r = await exec("ssh", ["-o", "ConnectTimeout=8", this.host, cmd], { stdin: o.stdin, timeout: o.timeout });
    if (r.timedOut) {
      if (check) fail("ssh timed out");
      return null;
    }
    if (r.code !== 0) {
      if (check) fail(`ssh failed (${r.code}): ${r.stderr.trim()}`);
      return null;
    }
    return r.stdout;
  }

  async script(s: string) {
    return (await exec("ssh", [this.host, "zsh -l -s"], { stdin: s, live: true })).code;
  }

  async tty(cmd: string) {
    return (await exec("ssh", ["-t", this.host, cmd], { tty: true })).code;
  }

  python(code: string, args: string[] = [], o: RunOptions = {}) {
    return this.run("/usr/bin/python3 -I - " + args.map(shq).join(" "), { ...o, stdin: code });
  }

  async pythonLive(code: string, args: string[] = []) {
    return (await exec("ssh", [this.host, "/usr/bin/python3 -I - " + args.map(shq).join(" ")], { stdin: code, live: true })).code;
  }

  async ssh(args: string[]) {
    return (await exec("ssh", args, { tty: true })).code;
  }
}
