// m3 plugin: pull a project's pushed commits on the target Mac and apply them (manual, one command).
//
//   plugins = ["my-mac-manager/examples/plugins/deploy.mjs"]
//
//   [projects.web]
//   clone = "~/Dev/web"
//   deploy = { branch = "main", steps = ["npm ci", "npm run build"], check = "curl -sf localhost:8080/health", check_timeout = 60 }
//     branch         optional. default: the branch the clone is on (must match when set)
//     steps          run in the clone directory, in order (e.g. rebuild, docker compose up -d, launchctl kickstart)
//     check          retried every 3s until check_timeout (default 60) seconds
//
//   m3 deploy <project> [--force]
//     1. managing machine: warns about uncommitted / unpushed changes in a local clone at the same path
//     2. target Mac: refuses a dirty clone → git fetch → fast-forward only → steps → check
//     3. steps or check fail → back to the previous commit, steps + check again → exit 1
//   --force: run steps + check even when already up to date

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const home = (p) => (p.startsWith("~/") ? `"$HOME"/${q(p.slice(2))}` : q(p));

function localWarnings(clone) {
  const dir = clone.replace(/^~(?=\/)/, homedir());
  if (!existsSync(dir + "/.git")) return [];
  const git = (...a) => {
    try { return execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
  };
  const out = [];
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  if (dirty) out.push(`local ${clone}: ${dirty.split("\n").length} uncommitted file(s)`);
  const ahead = git("rev-list", "--count", "@{u}..HEAD");
  if (ahead && ahead !== "0") out.push(`local ${clone}: ${ahead} unpushed commit(s)`);
  return out;
}

function script(p, force) {
  const d = p.deploy === true ? {} : p.deploy;
  const steps = (d.steps ?? []).map((s) => `  echo "\\$ "${q(s)}; ( ${s} ) || return 1`).join("\n") || "  :";
  const t = Number(d.check_timeout ?? 60);
  const check = d.check
    ? `  i=0; until ( ${d.check} ) >/dev/null 2>&1; do i=$((i+3)); [ $i -ge ${t} ] && { echo "check failed (${t}s): "${q(d.check)}; return 1; }; sleep 3; done; echo "check ok"`
    : "  :";
  return `cd ${home(p.clone)} || exit 1
cur=$(git symbolic-ref -q --short HEAD) || { echo "detached HEAD on the target Mac"; exit 1; }
branch=${d.branch ? q(d.branch) : '"$cur"'}
[ "$cur" = "$branch" ] || { echo "clone is on $cur, deploy branch is $branch"; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "dirty clone on the target Mac:"; git status --short --untracked-files=no; exit 1; fi
prev=$(git rev-parse HEAD)
git fetch -q origin "$branch" || exit 1
new=$(git rev-parse FETCH_HEAD)
if [ "$prev" = "$new" ]; then
  echo "up to date: $(git log -1 --format='%h %s')"
  ${force ? "" : "exit 0"}
else
  git log --format='  %h %s' "$prev..$new"
  git merge -q --ff-only "$new" || { echo "not a fast-forward ($branch diverged on the target Mac)"; exit 1; }
fi
run_steps() {
${steps}
}
run_check() {
${check}
}
if run_steps && run_check; then echo "deployed $(git log -1 --format='%h %s')"; exit 0; fi
echo "deploy failed → rollback to $(git log -1 --format='%h %s' "$prev")"
git reset -q --keep "$prev" && run_steps && run_check && echo "rollback ok" || echo "rollback FAILED"
exit 1
`;
}

/** @type {import("my-mac-manager/plugin").Plugin} */
export default {
  name: "deploy",
  apiVersion: 1,
  description: "m3 deploy <project>: fast-forward the target Mac clone to the pushed branch, run steps, check, roll back on failure",
  projectKeys: ["deploy"],
  commands: [{
    name: "deploy",
    summary: "pull pushed commits on the target Mac → steps → check (rollback on failure)",
    usage: "m3 deploy <project> [--force]",
    options: { force: { type: "boolean" } },
    async run(ctx, { values, positionals }) {
      const name = positionals[0];
      if (!name) {
        const names = ctx.projects.filter((p) => p.deploy).map((p) => p.name);
        ctx.fail("usage: m3 deploy <project> [--force]" + (names.length ? `\n  deployable: ${names.join(", ")}` : ""));
      }
      const p = ctx.projects.find((x) => x.name === name);
      if (!p) ctx.fail(`unknown project: ${name}`);
      if (!p.deploy) ctx.fail(`[projects.${name}] has no deploy key`);
      if (!p.clone) ctx.fail(`[projects.${name}] has no clone path`);
      for (const w of localWarnings(p.clone)) console.log(ctx.ui.warn("warn ") + w);
      console.log(ctx.ui.bold(`deploy ${name}`) + ctx.ui.dim(` → ${ctx.remote.host}:${p.clone}`));
      const rc = await ctx.remote.script(script(p, values.force));
      console.log(rc === 0 ? ctx.ui.ok("ok") : ctx.ui.bad(`failed (exit ${rc})`));
      return rc;
    },
  }],
};
