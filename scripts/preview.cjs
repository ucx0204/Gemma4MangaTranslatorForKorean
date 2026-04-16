const { join } = require("node:path");
const { spawn } = require("node:child_process");

const root = join(__dirname, "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [join(root, "node_modules", "electron", "cli.js"), "."], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  env
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
