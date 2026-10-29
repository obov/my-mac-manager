import { build } from "esbuild";
import { chmodSync, rmSync } from "node:fs";
rmSync("dist", { recursive: true, force: true });
const common = { bundle: true, platform: "node", format: "esm", target: "node22", loader: { ".py": "text", ".sh": "text" } };
await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/m3.js", banner: { js: "#!/usr/bin/env node" } });
await build({ ...common, entryPoints: ["src/plugin.ts"], outfile: "dist/plugin.js" });
chmodSync("dist/m3.js", 0o755);
