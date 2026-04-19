const { join } = require("node:path");
const { spawn } = require("node:child_process");
const { prepareRuntimeAssets } = require("./prepare-runtime.cjs");

const root = join(__dirname, "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
prepareRuntimeAssets({ root, outputDir: join(root, "out", "app-runtime") });

const child = spawn(process.execPath, [join(root, "node_modules", "electron", "cli.js"), "."], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  env
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
