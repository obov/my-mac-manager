// Types the password into the login window over Screen Sharing (VNC). Used by m3 login.
// Minimal RFB client: security type 30 (Apple Diffie-Hellman, ARD auth) → key events only.
// (type 33 makes the macOS 26 server close the connection)
// Prefer a Tailscale IP as host → the RFB session (keystrokes) only travels inside WireGuard
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { sleep } from "./util.js";

const KEY_RETURN = 0xff0d, KEY_SHIFT = 0xffe1, KEY_BACKSPACE = 0xff08;

class Reader {
  private buf = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private closed = false;
  private err: Error | null = null;
  constructor(sock: net.Socket) {
    sock.on("data", (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.notify(); });
    sock.on("close", () => { this.closed = true; this.notify(); });
    sock.on("error", (e) => { this.err = e; this.notify(); });
  }
  private notify() { const w = this.wake; this.wake = null; w?.(); }
  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.err) throw this.err;
      if (this.closed) throw new Error(`server closed the connection (${this.buf.length}/${n} bytes)`);
      await new Promise<void>((r) => (this.wake = r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

const toBig = (b: Buffer) => BigInt("0x" + (b.toString("hex") || "0"));
const toBuf = (x: bigint, len: number) => Buffer.from(x.toString(16).padStart(len * 2, "0"), "hex");

function modpow(b: bigint, e: bigint, m: bigint) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

export async function vncLogin(host: string, user: string, pw: string) {
  const sock = net.createConnection({ host, port: 5900 });
  sock.setTimeout(15000, () => sock.destroy(new Error("screen sharing connection timed out")));
  const r = new Reader(sock);
  try {
    const ver = await r.read(12);
    sock.write(ver.toString("latin1").startsWith("RFB 003.889") ? ver : Buffer.from("RFB 003.008\n"));
    const n = (await r.read(1))[0];
    if (n === 0) throw new Error("server refused: " + (await r.read((await r.read(4)).readUInt32BE(0))).toString());
    const types = [...(await r.read(n))];
    if (!types.includes(30)) throw new Error(`Apple DH (30) not offered: ${types}`);
    sock.write(Buffer.from([30]));

    // Apple Diffie-Hellman
    const hdr = await r.read(4);
    const gen = BigInt(hdr.readUInt16BE(0)), keylen = hdr.readUInt16BE(2);
    const prime = toBig(await r.read(keylen)), serverPub = toBig(await r.read(keylen));
    const priv = toBig(randomBytes(keylen)) % prime;
    const pub = modpow(gen, priv, prime), shared = modpow(serverPub, priv, prime);
    const key = createHash("md5").update(toBuf(shared, keylen)).digest();
    const creds = randomBytes(128);
    for (const [off, val] of [[0, user], [64, pw]] as const) {
      Buffer.concat([Buffer.from(val, "utf8").subarray(0, 63), Buffer.from([0])]).copy(creds, off);
    }
    const c = createCipheriv("aes-128-ecb", key, null);
    c.setAutoPadding(false);
    sock.write(Buffer.concat([c.update(creds), c.final(), toBuf(pub, keylen)]));
    if ((await r.read(4)).readUInt32BE(0) !== 0) throw new Error("screen sharing authentication failed (check user / password)");

    sock.write(Buffer.from([1]));   // ClientInit: shared
    const wh = await r.read(4);
    const w = wh.readUInt16BE(0), h = wh.readUInt16BE(2);
    await r.read(16);
    await r.read((await r.read(4)).readUInt32BE(0));
    sock.setTimeout(0);

    const keyEv = (sym: number, down: boolean) => {
      const b = Buffer.alloc(8);
      b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(sym, 4);
      sock.write(b);
    };
    const tap = async (sym: number) => { keyEv(sym, true); keyEv(sym, false); await sleep(30); };
    // screensharingd maps keysyms to key codes without adding Shift → hold Shift explicitly (US layout)
    const type = async (ch: string) => {
      if (!/[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(ch)) return tap(ch.codePointAt(0)!);
      keyEv(KEY_SHIFT, true); await sleep(20);
      await tap(ch.codePointAt(0)!);
      keyEv(KEY_SHIFT, false); await sleep(20);
    };
    // wake the display: pointer move + Shift
    const ptr = Buffer.alloc(6);
    ptr[0] = 5; ptr[1] = 0; ptr.writeUInt16BE(w >> 1, 2); ptr.writeUInt16BE(h >> 1, 4);
    sock.write(ptr);
    await tap(KEY_SHIFT);
    await sleep(2000);
    // login window with a single user → password field has focus
    for (let i = 0; i < 64; i++) await tap(KEY_BACKSPACE);   // clear leftovers from an earlier attempt
    for (const ch of pw) await type(ch);
    await tap(KEY_RETURN);
    await sleep(3000);
    console.log("password keystrokes sent");
  } finally {
    sock.end();
    sock.destroy();
  }
}
