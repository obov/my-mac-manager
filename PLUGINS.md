# m3 plugin spec (apiVersion 1)

Written so that a person or a coding agent can build a plugin from this document alone. Validate with `m3 plugin check [--remote]` when done.

## 1. Shape

- One ES module. `default export` = the plugin object (or a function returning it, async allowed)
- No dependencies required. For type hints only: `/** @type {import("my-mac-manager/plugin").Plugin} */`
- File types: `.mjs` / `.js`. `.ts` only works on Node 22.18+ (type stripping)

```js
/** @type {import("my-mac-manager/plugin").Plugin} */
export default {
  name: "my-plugin",      // required. lowercase letters, digits, -
  apiVersion: 1,
  description: "one line",
  // everything below is optional
  vault, backup, services, collectors, commands, remoteFiles, agents, bootstrap, hooks, projectKeys,
};
```

Scaffold: `m3 plugin new <name> --kind service|vault|backup|command` → `plugins/<name>.mjs`

Full example: [examples/plugins/agent-sessions.mjs](examples/plugins/agent-sessions.mjs) (collector, commands, remote file, launchd agent, reboot hook). Use it directly with `plugins = ["my-mac-manager/examples/plugins/agent-sessions.mjs"]`.

## 2. Loading (m3.toml)

| Setting | Meaning |
|---|---|
| `plugins = ["./plugins/x.mjs", "foo"]` | always loaded. For services, collectors, commands, hooks |
| `[vault] use = "..."` | the vault slot (one) |
| `[backup] use = "..."` | the backup slot (one) |
| `[plugin.<name>]` | settings for that plugin → `ctx.options` |

How `use` / `plugins` values resolve:
1. Builtin names: `bitwarden`, `restic`, `launchd`, `docker`, `compose`, `apps`, `heartbeat`, `logscan`, `ports`. `my-mac-manager/<path>`: a file shipped with m3 (e.g. `examples/plugins/...`)
2. Starts with `.`, `/` or `~`: file path relative to m3.toml
3. Anything else: an npm package. `foo` → tries `m3-plugin-foo` first, then `foo`. Searched in `node_modules` of the m3.toml directory, then next to the m3 install (for global installs: `npm i -g m3-plugin-foo`)

For slot plugins `ctx.options` = that table without `use` (`[vault]`, `[backup]`).

## 3. Where code runs, and limits

| Where | Code | Limits |
|---|---|---|
| Managing machine (runs m3) | all plugin JS | Node 22+ |
| Target Mac (over ssh) | `collectors[].code`, `remoteFiles`, shell lines | `/usr/bin/python3` 3.9 standard library only, no pip packages. Use absolute Homebrew paths such as `/opt/homebrew/bin` (not on PATH in non-login ssh shells) |

Secrets:
- Never print secrets or pass them as command arguments. Send them over stdin (`run(cmd, { stdin })`)
- Compare with hashes (see `compareCredentials`)

## 4. Context (`ctx`)

First argument of every function.

| Member | Meaning |
|---|---|
| `config` | the whole m3.toml |
| `root` | directory of m3.toml |
| `id` | remote namespace (`[remote].id`, default `m3`) |
| `options` | this plugin's settings |
| `projects` | `[{ name, ...[projects.<name>] }]` |
| `remote.host` / `dir` / `credDir` / `helper` | ssh host / m3 directory relative to `~/` / credentials directory / LaunchDaemon helper path |
| `remote.run(cmd, { stdin, check, timeout })` | returns stdout. With `check: false`, `null` on failure (default: print the error and exit) |
| `remote.script(zsh)` | run in a remote login zsh, output streamed → exit code |
| `remote.tty(cmd)` | interactive `ssh -t` (sudo prompts) → exit code |
| `remote.python(code, args)` / `pythonLive(code, args)` | run with `/usr/bin/python3 -I -` → stdout / exit code |
| `ui.ok/bad/warn/dim/bold(s)` | colored strings |
| `ui.dur(sec)` | `5m`, `3h`, `2d4h` |
| `ui.ask(q)` | read one line |
| `ui.poll(desc, fn, { timeout, every, detail, stall })` | wait until `fn()` is truthy |
| `probe({ check })` | collect target Mac state (facts) |
| `withVault(fn)` | open the vault → `fn(vault)` → always close |
| `backup()` / `backupPlan()` | backup slot instance / what to back up |
| `status(names)` | print `m3 status` |
| `fail(msg)` | print an error and exit |

## 5. Slot: vault

```js
vault: (ctx) => ({
  async open() {},                 // unlock. Interactive input (master password) via stdio: "inherit"
  async close() {},                // always called (invalidate session keys)
  async sync() {},                 // optional
  async get(name) {},              // exactly one match | null. ctx.fail on more than one
  async list(prefix) {},           // all items whose name starts with prefix (including notes)
  async putNote(name, content) {}, // create a secure note or replace its notes
})
```

Item shape (`VaultItem`):

```js
{ name, notes, password, type, fields: [{ name, value }], files: [{ name, read: async () => "content" }] }
```

Where m3 uses the vault:
- The `[vault].item` item: backup credentials and the Mac login password (`m3 creds`, `m3 login`, `m3 reboot`)
  - Credentials are collected as KEY=VALUE from: `KEY=VALUE` lines in notes → fields (the part of the name after the last `>`) → `*.env` attachments → aliased attachments
  - Login password: field `[vault].login_password_field` (default `password`), else `password`
- Secure notes named `[vault].env_prefix + <path relative to $HOME>`: raw `.env` files (`m3 env`)

Example: with the 1Password CLI (`op`), `get` = `op item get <name> --format json` mapped to the shape above, `putNote` = `op item create --category "Secure Note"` / `op item edit`.

## 6. Slot: backup

```js
backup: (ctx) => ({
  credentials: { required: ["KEY"], optional: [], aliases: { "field name (lowercase)": "KEY", "@password": "KEY" } },
  async writeCredentials(kv) {},          // kv (uppercase keys) → target Mac ~/${ctx.remote.credDir}, mode 600
  async compareCredentials(kv) {},        // { KEY: "same" | "diff" | "none" }. Hash with sha256 on the target Mac and compare
  async hasCredentials() {},
  async run(action) {},                   // "now" | "snapshots" | "verify" | "log" → exit code
  async restore(what, { name, target }) {},  // "secrets" | "dirs" | "data"
  restoreDataCommand(name) {},            // shell command the target Mac runs before a project's setup during bootstrap
  projectRestoreCommands(project) {},     // optional: more restore commands for a project (e.g. restic restore_snapshot)
  remoteFiles() {}, remoteOptions() {}, agents() {},   // optional: files to install / backup value in config.json / scheduled plist
})
```

`ctx.backupPlan()` = `{ secrets, dirs, dirs_exclude, data: { project: { backup, restore } } }`
- Paths are relative to `$HOME`
- `data.backup`: shell command that writes a dump to stdout, `data.restore`: shell command that reads it from stdin

`m3 install` writes `{ id, dir, plan, backup: remoteOptions() }` to `~/<dir>/config.json` on the target Mac, so scheduled scripts can read it.

## 7. Services and collectors

Status flow: the Python code of all collectors is bundled and run in **one ssh call** → `facts` → each service's `check(ctx, project, facts)` → rows.

```js
collectors: [{
  name: "my_thing",                 // facts.my_thing. lowercase letters, digits, _
  arg: (ctx) => ({ paths: [...] }), // JSON-serializable value → arg of collect
  code: String.raw`
def collect(arg, facts):
    # available: sh(cmd_list, timeout=20) → stdout ("" on failure), HOME, parse_ts(line), etime_sec(s),
    #            json, os, re, glob, time, subprocess, shutil, datetime
    # facts: now, boot, console_user, procs[{pid,ppid,age,rss_mb,cmd}], ports[{port,addr,pid,cmd}], dirs, earlier collectors
    return {...}
`,
}],
services: [{
  name: "my-thing",
  keys: ["my_thing"],               // check/kinds/control/logs only run for projects that have one of these keys
  check: (ctx, p, facts) => [{ ok: true, tag: "mything", what: "target", info: "state" }],  // tag up to 7 chars
  kinds: (p) => ["mything×1"],     // m3 ls summary
  control: (ctx, p, action) => ({ lines: ["one remote zsh line"], tty: [{ label, cmd }] }),  // start|stop|restart
  logs: (ctx, p, n) => ["one remote zsh line"],
  audit: (ctx, facts) => [{ title: "undeclared X", items: ["..."] }],   // note: true = informational (not counted)
}],
```

Rules:
- A collector exception is recorded in `facts._errors[name]` and shown as a warning. Other collectors keep running
- `check` is synchronous. Collect anything remote in a collector beforehand
- Service order = builtins (launchd, docker, compose, apps, heartbeat, logscan, ports) → order of `plugins`
- `control.lines` run in one go after `U=$(id -u)` is defined. Reversed as a whole on stop

## 8. Commands, remote files, launchd, bootstrap, hooks

```js
commands: [{
  name: "my-cmd", summary: "one line", usage: "m3 my-cmd [--yes]",
  options: { yes: { type: "boolean" }, hours: { type: "string", short: "H" } },   // node:util parseArgs format
  async run(ctx, { values, positionals }) { return 0; },                          // exit code
}],
remoteFiles: (ctx) => [{ name: "my.py", content: "...", mode: 0o755 }],   // ~/<dir>/my.py (m3 install / host / bootstrap)
agents: (ctx) => [{ label: "com.me.job", plist: "<?xml ...>" }],          // ~/Library/LaunchAgents. __HOME__ and __DIR__ substituted
bootstrap: (ctx) => [{ desc: "step", phase: "before-projects" | "finish", run: async (ctx) => 0 }],
hooks: { beforeReboot: (ctx, facts) => ["lines shown before m3 reboot asks for confirmation"] },
projectKeys: ["my_key"],   // project keys read besides service keys (excluded from the unknown-key warning of m3 plugin check)
```

- Command names cannot clash with built-in commands
- If an `agents` label was already moved to a LaunchDaemon (`/Library/LaunchDaemons/<label>.plist` exists), `m3 install` re-applies it to the LaunchDaemon

## 9. Checklist

- [ ] `m3 plugin check ./plugins/x.mjs` reports no problems
- [ ] With collectors: `m3 plugin check ./plugins/x.mjs --remote` (compiles with python 3.9 on the target Mac)
- [ ] No secrets in output, command arguments or logs
- [ ] vault: `m3 creds check` and `m3 env status` work
- [ ] backup: `m3 backup snapshots` and `m3 backup verify` work
- [ ] services: `m3 status <project>` and `m3 audit`

## 10. Publishing to npm

- Package name `m3-plugin-<name>` (or `@scope/m3-plugin-<name>`), `"type": "module"`, `exports` or `main` = the plugin file
- Add `m3-plugin` to `keywords`
- Users: `npm i -g m3-plugin-<name>` or `npm i m3-plugin-<name>` in the m3.toml directory → `use = "<name>"`
