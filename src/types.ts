// m3 plugin API (apiVersion 1). Spec: PLUGINS.md
export type Dict = Record<string, any>;

// ---------- remote state (probe) ----------
export interface Proc { pid: number; ppid: number; age: number; rss_mb: number; cmd: string }
export interface Port { port: number; addr: string; pid: number; cmd: string }

/** state gathered in one remote run: built-in facts + one entry per collector name */
export interface Facts {
  now: number;
  boot: number | null;
  console_user: string;
  procs: Proc[];
  ports: Port[];
  /** directory names under [audit].root */
  dirs: string[];
  /** collector failures: name → message */
  _errors?: Record<string, string>;
  [collector: string]: any;
}

/** one check result row. tag: up to 7 chars (launchd, job, docker, ports, ...) */
export interface Row { ok: boolean; tag: string; what: string; info: string }

/** m3.toml [projects.<name>] + name */
export interface Project extends Dict {
  name: string;
  desc?: string;
  repo?: string;
  clone?: string;
  gui?: boolean;
  daemon?: boolean;
}

// ---------- runtime ----------
export interface RunOptions { stdin?: string; check?: boolean; timeout?: number }

export interface Remote {
  host: string;
  /** m3 file directory on the target Mac, relative to $HOME (e.g. .local/share/m3) */
  dir: string;
  /** credentials directory, relative to $HOME (e.g. .config/m3) */
  credDir: string;
  /** LaunchDaemon helper path (/usr/local/libexec/<id>-launchd) */
  helper: string;
  /** run a command → stdout. With check=false, null on failure */
  run(cmd: string, o?: RunOptions): Promise<string | null>;
  /** run a script in a remote login zsh, output streamed → exit code */
  script(zsh: string): Promise<number>;
  /** interactive command such as sudo (ssh -t) → exit code */
  tty(cmd: string): Promise<number>;
  /** run code with /usr/bin/python3 -I → stdout */
  python(code: string, args?: string[], o?: RunOptions): Promise<string | null>;
  /** run code with /usr/bin/python3 -I, output streamed → exit code */
  pythonLive(code: string, args?: string[]): Promise<number>;
  /** run ssh interactively with these exact arguments (host included) */
  ssh(args: string[]): Promise<number>;
}

export interface PollOptions { timeout: number; every?: number; detail?: () => string; stall?: number }

export interface UI {
  ok(s: unknown): string;
  bad(s: unknown): string;
  warn(s: unknown): string;
  dim(s: unknown): string;
  bold(s: unknown): string;
  dur(sec: number | null | undefined): string;
  ask(question: string): Promise<string>;
  /** wait until fn() returns something truthy */
  poll<T>(desc: string, fn: () => Promise<T | null | undefined | false | "">, o: PollOptions): Promise<T | null>;
}

export interface BackupPlan {
  /** paths relative to $HOME */
  secrets: string[];
  dirs: string[];
  dirs_exclude: string[];
  /** project name → { backup: command that dumps to stdout, restore: command that reads stdin } */
  data: Record<string, { backup: string; restore: string }>;
}

export interface Context {
  /** the whole m3.toml */
  config: Dict;
  /** directory containing m3.toml */
  root: string;
  /** remote namespace ([remote].id, default m3) */
  id: string;
  /** this plugin's settings: vault → [vault], backup → [backup], otherwise [plugin.<name>] */
  options: Dict;
  projects: Project[];
  remote: Remote;
  ui: UI;
  probe(o?: { check?: boolean }): Promise<Facts | null>;
  withVault<T>(fn: (v: Vault) => Promise<T>): Promise<T>;
  backup(): Backup;
  backupPlan(): BackupPlan;
  /** print m3 status <names> → exit code */
  status(names?: string[]): Promise<number>;
  fail(msg: string): never;
}

// ---------- slots ----------
export interface VaultItem {
  name: string;
  notes: string;
  /** the item's main password */
  password?: string;
  fields: { name: string; value: string }[];
  files?: { name: string; read(): Promise<string> }[];
  /** type for display (login, secure note, ...) */
  type?: string;
}

export interface Vault {
  /** unlock / log in. Ask for the master password here */
  open?(): Promise<void>;
  /** end the session / lock. Always called by withVault */
  close?(): Promise<void>;
  /** sync with the server */
  sync?(): Promise<void>;
  /** item with exactly this name. null if none, error if more than one */
  get(name: string): Promise<VaultItem | null>;
  /** items whose name starts with prefix (including notes) */
  list(prefix: string): Promise<VaultItem[]>;
  /** create a secure note or replace its notes */
  putNote(name: string, content: string): Promise<void>;
}

export type CredState = "same" | "diff" | "none";

export interface Backup {
  credentials: {
    required: string[];
    optional?: string[];
    /** vault field / attachment name (lowercase) → key. "@password" = the item's main password */
    aliases?: Record<string, string>;
  };
  writeCredentials(kv: Record<string, string>): Promise<void>;
  /** compare each key with the target Mac value (never send or print values; compare hashes) */
  compareCredentials(kv: Record<string, string>): Promise<Record<string, CredState>>;
  hasCredentials(): Promise<boolean>;
  run(action: "now" | "snapshots" | "verify" | "log"): Promise<number>;
  restore(what: "secrets" | "dirs" | "data", o: { name?: string; force?: boolean; target?: string }): Promise<number>;
  /** shell command restoring project data before its setup during bootstrap (runs on the target Mac) */
  restoreDataCommand(name: string): string;
  remoteFiles?(): RemoteFile[];
  /** settings installed on the target Mac (backup entry of config.json) */
  remoteOptions?(): Dict;
  agents?(): Agent[];
}

// ---------- building blocks ----------
/** state collection code that runs on the target Mac. python 3.9 standard library only.
 *  Define `def collect(arg, facts):` returning a JSON-serializable value. Result: facts[name] */
export interface Collector {
  name: string;
  code: string;
  arg?(ctx: Context): unknown | Promise<unknown>;
}

export interface ControlPlan {
  /** lines run in one remote zsh. Each line is a unit (reversed on stop) */
  lines?: string[];
  /** interactive (sudo) commands */
  tty?: { label: string; cmd: string }[];
}

export interface AuditSection { title: string; items: string[]; note?: boolean }

export interface Service {
  name: string;
  /** project keys this service handles. Functions below run for projects with any of them */
  keys: string[];
  check?(ctx: Context, p: Project, facts: Facts): Row[];
  kinds?(p: Project): string[];
  control?(ctx: Context, p: Project, action: "start" | "stop" | "restart"): ControlPlan;
  /** remote zsh lines (print logs) */
  logs?(ctx: Context, p: Project, lines: number): string[];
  /** called on audit regardless of project keys */
  audit?(ctx: Context, facts: Facts): AuditSection[];
}

export interface CommandArgs { values: Dict; positionals: string[] }

export interface Command {
  name: string;
  summary: string;
  usage?: string;
  /** node:util parseArgs options format */
  options?: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean; default?: any }>;
  run(ctx: Context, args: CommandArgs): Promise<number | void>;
}

export interface RemoteFile { name: string; content: string; mode?: number }

/** plist deployed to ~/Library/LaunchAgents. __HOME__ and __DIR__ are substituted */
export interface Agent { label: string; plist: string }

export interface Step {
  desc: string;
  /** before-projects: after repo clone and host settings, before project setup / finish: after loading launchd, before the final check */
  phase: "before-projects" | "finish";
  run(ctx: Context): Promise<number | void>;
}

export interface Plugin {
  name: string;
  apiVersion?: 1;
  description?: string;
  vault?(ctx: Context): Vault;
  backup?(ctx: Context): Backup;
  services?: Service[];
  collectors?: Collector[];
  commands?: Command[];
  remoteFiles?(ctx: Context): RemoteFile[];
  agents?(ctx: Context): Agent[];
  bootstrap?(ctx: Context): Step[];
  hooks?: {
    /** warning lines shown before m3 reboot asks for confirmation */
    beforeReboot?(ctx: Context, facts: Facts): string[] | Promise<string[]>;
  };
  /** extra project keys this plugin reads (excluded from the unknown-key warning) */
  projectKeys?: string[];
}
