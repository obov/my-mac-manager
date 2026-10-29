import { spawnSync } from "node:child_process";
import type { Context, Plugin, Vault, VaultItem } from "../types.js";
import { BAD, DIM, fail } from "../util.js";

const TYPES: Record<number, string> = { 1: "login", 2: "secure note", 3: "card", 4: "identity" };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

class Bitwarden implements Vault {
  private session = "";
  constructor(private ctx: Context) {}

  private bw(...args: string[]): string;
  private bw(args: string[], stdin: string): string;
  private bw(...a: any[]): string {
    const [args, stdin] = Array.isArray(a[0]) ? [a[0] as string[], a[1] as string] : [a as string[], undefined];
    const r = spawnSync("bw", [...args, "--session", this.session], { input: stdin, encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status !== 0) fail(`Bitwarden failed (${args.slice(0, 2).join(" ")}): ${(r.stderr || "").trim()}`);
    return r.stdout;
  }

  async open() {
    if (spawnSync("which", ["bw"]).status !== 0) fail("bw not found → brew install bitwarden-cli");
    const st = JSON.parse(spawnSync("bw", ["status"], { encoding: "utf8" }).stdout || "{}").status;
    let session = process.env.BW_SESSION ?? "";
    const raw = (cmd: string) =>
      (spawnSync("bw", [cmd, "--raw"], { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" }).stdout || "").trim();
    if (st === "unauthenticated") session = raw("login");   // master password once, session key never printed
    if (!session) {
      console.error("Unlock Bitwarden (master password)");
      session = raw("unlock");
    }
    if (!session) fail("no Bitwarden session (wrong password?)");
    this.session = session;
  }

  async close() {
    spawnSync("bw", ["lock"], { stdio: "ignore" });   // invalidate the session key
  }

  async sync() {
    this.bw("sync");
  }

  private toItem(i: any): VaultItem {
    return {
      name: i.name,
      notes: i.notes ?? "",
      password: i.login?.password ?? undefined,
      type: TYPES[i.type] ?? String(i.type),
      fields: (i.fields ?? []).filter((f: any) => f.name).map((f: any) => ({ name: f.name, value: f.value ?? "" })),
      files: (i.attachments ?? []).map((at: any) => ({
        name: at.fileName ?? "",
        read: async () => this.bw("get", "attachment", at.id, "--itemid", i.id, "--raw"),
      })),
    };
  }

  private exact(name: string): any | null {
    const hits = JSON.parse(this.bw("list", "items", "--search", name)).filter((i: any) => i.name === name);
    if (hits.length > 1) fail(BAD(`Bitwarden has ${hits.length} items named '${name}' → keep only one`));
    return hits[0] ?? null;
  }

  async get(name: string) {
    let item = this.exact(name);
    // rename an item with the old name to the new one ([vault].legacy_item)
    const legacy = this.ctx.options.legacy_item;
    if (!item && legacy && name === this.ctx.options.item) {
      item = this.exact(legacy);
      if (item) {
        item.name = name;
        this.bw(["edit", "item", item.id], b64(item));
        console.log(DIM(`  Bitwarden item renamed: '${legacy}' → '${name}'`));
      }
    }
    return item ? this.toItem(item) : null;
  }

  async list(prefix: string) {
    return JSON.parse(this.bw("list", "items", "--search", prefix))
      .filter((i: any) => i.name.startsWith(prefix)).map((i: any) => this.toItem(i));
  }

  async putNote(name: string, content: string) {
    const cur = this.exact(name);
    if (cur) {
      const item = JSON.parse(this.bw("get", "item", cur.id));
      item.notes = content;
      this.bw(["edit", "item", item.id], b64(item));
    } else {
      this.bw(["create", "item"], b64({ type: 2, name, notes: content, secureNote: { type: 0 }, favorite: false,
        reprompt: 0, fields: [], folderId: null, organizationId: null }));
    }
  }
}

const plugin: Plugin = {
  name: "bitwarden",
  description: "Bitwarden CLI (bw) vault",
  vault: (ctx) => new Bitwarden(ctx),
};
export default plugin;
