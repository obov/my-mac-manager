# my-mac-manager (`m3`)

A CLI for managing a headless Mac (Mac mini, EC2 Mac) over ssh from another machine:
status checks, service control, backups, FileVault-aware reboots and rebuilding a new Mac (bootstrap).

- The engine (this package) and your setup (`m3.toml` + your own plugins) live in separate repositories
- `m3.toml` holds values only (like Terraform variables): services, repos, secrets, brew packages, tools, launchd jobs. All logic lives in m3 and its plugins
- Vault (Bitwarden, ...), backup (restic, ...) and service checks are plugins you can swap or add → [PLUGINS.md](PLUGINS.md), examples in [examples/plugins](examples/plugins)

## Install

```sh
npm i -g my-mac-manager
m3 init ~/my-mac --host mini     # creates ~/my-mac/m3.toml (keep it in git)
cd ~/my-mac && m3
```

Requirements
- Managing machine: Node 22+, `ssh` with key login to the target Mac, the CLI of your vault (e.g. `bw`)
- Target Mac: macOS with Remote Login (SSH) enabled. Remote code only uses `/usr/bin/python3` (Xcode CLT) and `sh`

Config lookup: `--config` → `$M3_CONFIG` → `m3.toml` in the current or a parent directory → `~/.config/m3/m3.toml`

## Commands

| Command | Purpose |
|---|---|
| `m3` / `m3 status [project]` | summary / details |
| `m3 logs <project> [-n 50]` | launchd / compose logs |
| `m3 start\|stop\|restart <project>` | control (gui / system domain detected) |
| `m3 audit` | launchd jobs, containers, ports and orphan processes not in m3.toml |
| `m3 reboot` / `m3 unlock` / `m3 wait` / `m3 login` | planned reboot (FileVault authrestart + automatic login over Screen Sharing) / unlock FileVault over SSH after a power loss / wait for recovery / GUI login |
| `m3 daemonize [project] [--rollback]` | move `daemon = true` projects to LaunchDaemons (start at boot without a GUI login) |
| `m3 install` | deploy and load remote scripts, config and launchd plists |
| `m3 host plan\|apply` | host settings (pmset, SSH, Screen Sharing, automatic updates, helper and sudoers): check / apply |
| `m3 creds check\|push` | backup credentials: vault item → target Mac |
| `m3 env [status\|push\|pull]` | `.env` files ↔ vault secure notes (shows key names only, never values) |
| `m3 backup [now\|snapshots\|verify\|log]` / `m3 restore ...` | backup / restore |
| `m3 bootstrap <ssh-host> [--list] [--from N]` | rebuild everything on a new Mac |
| `m3 plugin list\|new\|check` | list, scaffold and validate plugins |

## m3.toml

```toml
plugins = ["./plugins/my-check.mjs"]   # extra plugins (must come before the first [table])

[remote]
id = "m3"                    # namespace on the target Mac: ~/.local/share/<id>, ~/.config/<id>, /usr/local/libexec/<id>-launchd
files = ["scripts/x.sh"]     # extra files deployed to ~/.local/share/<id>/

[host]
ssh = "mini"                 # required. Host from ~/.ssh/config
hostname = "my-mac"          # set by m3 host apply
vnc_host = "100.x.y.z"       # address for m3 login (a Tailscale IP is recommended)
screen_sharing = "vnc://my-mac.local"
# brewfile = "host/Brewfile" # alternative to [brew]
# tools = "host/tools.sh"    # alternative to [[tools]]
# settings = "host/extra.sh" # extra checks for m3 host (check / note / ok functions)
# launchd = ["launchd"]      # plist files / dirs, alternative to [[projects.<name>.agents]]
secrets = ["~/.ssh/id_ed25519"]   # secrets to back up
dirs = ["~/notes"]                # directories to back up (tar)
dirs_exclude = ["node_modules"]

[vault]
use = "bitwarden"
item = "m3 > my-mac"         # item with backup credentials and the Mac login password
env_prefix = "m3 > my-mac env: "
login_password_field = "password"

[backup]
use = "restic"
required = ["RESTIC_REPOSITORY", "RESTIC_PASSWORD", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
aliases = { "encrypt token" = "RESTIC_PASSWORD" }   # vault field name → key
schedule = { hour = 4, minute = 30 }

[brew]                       # rendered into a Brewfile (bootstrap: brew bundle)
taps = ["owner/tap"]
formulae = ["restic", { name = "node@24", link = true }]
casks = []
mas = { "App Name" = 123456789 }

[[tools]]                    # installed outside brew during bootstrap; skipped when bin / check passes
name = "bun"
bin = "~/.bun/bin/bun"       # or check = "<shell test>"
install = "curl -fsSL https://bun.sh/install | bash"   # or manual = "message"

[audit]
root = "~/Dev"               # list directories here that m3.toml does not reference

[bootstrap]
path = ["~/.local/bin"]      # prepended to PATH while running project setup

[workspace]                  # repos without services
repos = [{ repo = "https://github.com/me/notes.git", clone = "~/Dev/notes" }]

[projects.web]
desc = "description"
repo = "git@github.com:me/web.git"
clone = "~/Dev/web"
launchd = ["com.me.web"]           # long-running (pid checked)
launchd_jobs = ["com.me.web.cron"] # periodic (last exit 0)
launchd_system = ["sh.brew.x"]     # LaunchDaemon installed by something else
daemon = true                      # move to a LaunchDaemon
daemon_ready = "curl -sf localhost:8080/health"   # checked after the move, rolled back on failure
requires = "test -f ~/ready"       # precondition for the move
compose = "cd ~/Dev/web && docker compose"
docker = ["web-app-1"]
ports = [8080]
apps = ["/Applications/X.app/Contents/MacOS/X"]
heartbeat = { file = "~/.web/runs.jsonl", max_minutes = 60 }
errors = [{ file = "~/Library/Logs/web.log", since = "com.me.web", match = "ERROR", ignore = ["harmless"] }, { docker = "web-app-1" }]
gui = true                         # needs a GUI login session
secrets = ["~/Dev/web/.env"]
env = ["~/Dev/web/.env"]           # synced with a vault secure note
dirs = ["~/Dev/web/data"]
data_backup = "docker exec db pg_dumpall -U postgres"     # dump to stdout
data_restore = "docker exec -i db psql -U postgres"       # restore from stdin
setup = ["cd ~/Dev/web && npm ci"]                        # run during bootstrap ($M3_DIR available)
restore_snapshot = { tag = "web", host = "oldmac", repo_suffix = false, paths = ["data"], target = "~/web" }   # restic: copy dirs from another backup during bootstrap (m3 restore-snapshot web)

[[projects.web.agents]]            # launchd plist rendered from values (~/ → $HOME)
label = "com.me.web"
program = ["/opt/homebrew/bin/node", "~/Dev/web/server.js"]
working_dir = "~/Dev/web"
env = { PORT = "8080", PATH = "/opt/homebrew/bin:/usr/bin:/bin" }
run_at_load = true
keep_alive = true                  # also: throttle, interval, calendar = { Hour = 4, Minute = 30 }, log, stdout, stderr
log = "~/Library/Logs/web.log"

[ignore]                     # excluded from audit
launchd = []
ports = []
port_cmds = []
docker_exited = []
orphan_cmds = []
```

## Plugins

```toml
plugins = ["my-mac-manager/examples/plugins/agent-sessions.mjs", "./plugins/mine.mjs", "foo"]   # bundled example / local file / npm m3-plugin-foo
```

Scaffold and validate: `m3 plugin new mine --kind service|vault|backup|command`, `m3 plugin check --remote`. Spec: [PLUGINS.md](PLUGINS.md).

Bundled plugins (opt-in, settings at the top of each file):

| Plugin | Adds |
|---|---|
| `examples/plugins/agent-sessions.mjs` | stale agent browsers, Claude session activity, reboot warning (`m3 stale`, `m3 reap`) |
| `examples/plugins/deploy.mjs` | `m3 deploy <project>`: fast-forward the target Mac clone to the pushed branch, run `deploy.steps`, `deploy.check`, roll back on failure |
| `examples/plugins/alert.mjs` | error mails sent by apps on the target Mac (`m3-alert.py send` / `run`) or from watched logs; events and delivery kept in SQLite (`m3 alert`, `alert` row in `m3 status`) |

## Development

```sh
npm i
npm run build        # dist/m3.js (single bundle), dist/plugin.js, dist/types
npm run typecheck
node dist/m3.js --config ../my-mac/m3.toml
ln -sf "$PWD/dist/m3.js" ~/.local/bin/m3-dev   # optional: local build as m3-dev, next to the npm m3
```

`m3 -v` on a source checkout prints `<version> (dev: <path>)`.
