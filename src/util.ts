import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { PollOptions } from "./types.js";

export const TTY = !!process.stdout.isTTY;
const color = (code: number) => (s: unknown) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const OK = color(32), BAD = color(31), WARN = color(33), DIM = color(2), BOLD = color(1);

export function dur(sec: number | null | undefined): string {
  if (sec == null) return "-";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d${Math.floor((sec % 86400) / 3600)}h`;
}

export function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const out = (s: string) => process.stdout.write(s);

export function shq(s: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

/** ~/x → x (relative to $HOME) */
export const rel = (p: string) => (p.startsWith("~/") ? p.slice(2) : p);
/** ~/x → $HOME/x (for shell) */
export const shHome = (p: string) => (p.startsWith("~/") ? "$HOME/" + p.slice(2) : p);

export async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

function envLines(text: string): [string, string][] {
  const res: [string, string][] = [];
  for (let line of (text || "").split("\n")) {
    line = line.trim();
    if (line.startsWith("export ")) line = line.slice(7);
    if (line.includes("=") && !line.startsWith("#")) {
      const i = line.indexOf("=");
      res.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return res;
}

/** KEY=VALUE lines → into (quotes stripped) */
export function parseKv(text: string, into: Record<string, string> = {}) {
  for (const [k, v] of envLines(text)) into[k] = v.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
  return into;
}

/** KEY=VALUE lines → key → value hash */
export function envKeys(text: string): Record<string, string> {
  return Object.fromEntries(envLines(text).map(([k, v]) => [k, sha256(v)]));
}

/** diff of two key→hash maps (key names only): +only in b, -only in a, ~value differs */
export function keyDiff(a: Record<string, string>, b: Record<string, string>): string[] {
  const ak = Object.keys(a), bk = Object.keys(b);
  return [
    ...bk.filter((k) => !(k in a)).sort().map((k) => `+${k}`),
    ...ak.filter((k) => !(k in b)).sort().map((k) => `-${k}`),
    ...ak.filter((k) => k in b && a[k] !== b[k]).sort().map((k) => `~${k}`),
  ];
}

export const isUpperKey = (k: string) => /[A-Z]/.test(k) && k === k.toUpperCase();

let interrupted = false;

async function nap(ms: number) {
  const end = Date.now() + ms;
  while (!interrupted && Date.now() < end) await sleep(Math.min(250, end - Date.now()));
}

/** wait until fn() is truthy. detail = current state shown on the wait line,
 *  stall = give up early when detail has not changed for this many seconds */
export async function poll<T>(desc: string, fn: () => Promise<T | null | undefined | false | "">, o: PollOptions): Promise<T | null> {
  const every = o.every ?? 10;
  const t0 = Date.now();
  let last: string | null = null, since = t0;
  interrupted = false;
  const onInt = () => { interrupted = true; };
  process.on("SIGINT", onInt);
  try {
    while ((Date.now() - t0) / 1000 < o.timeout && !interrupted) {
      const r = await fn();
      if (interrupted) break;
      const el = Math.floor((Date.now() - t0) / 1000);
      if (r) {
        out(`\r\x1b[K${OK("o")} ${desc} (${el}s)\n`);
        return r;
      }
      const d = o.detail ? o.detail() : "";
      if (d !== last) { last = d; since = Date.now(); }
      if (o.stall && d && (Date.now() - since) / 1000 >= o.stall) {
        out(`\r\x1b[K${BAD("x")} ${desc}: no change for ${o.stall}s → giving up (${d})\n`);
        return null;
      }
      const line = `  ${desc}: waiting ${el}s/${o.timeout}s`;
      const room = (process.stdout.columns || 120) - line.length - 6;
      out(`\r\x1b[K${line}` + (d ? `  ${DIM(d.slice(0, Math.max(room, 20)))}` : ""));
      await nap(every * 1000);
    }
    if (interrupted) {
      out(`\r\x1b[K${WARN("-")} ${desc}: wait aborted (Ctrl-C)\n`);
      return null;
    }
    out(`\r\x1b[K${BAD("x")} ${desc}: timed out (${o.timeout}s)` + (last ? `  ${last}` : "") + "\n");
    return null;
  } finally {
    process.off("SIGINT", onInt);
  }
}
