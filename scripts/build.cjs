const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { prepareRuntimeAssets } = require("./prepare-runtime.cjs");

const root = join(__dirname, "..");

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false
  });
  if (result.error) {
    console.error(result.error);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(process.execPath, [nodeBin("typescript", "bin", "tsc"), "--noEmit"]);
run(process.execPath, [nodeBin("typescript", "bin", "tsc"), "-p", "tsconfig.electron.json"]);
run(process.execPath, [nodeBin("vite", "bin", "vite.js"), "build", "--config", "vite.renderer.config.ts"]);
prepareRuntimeAssets({ root, outputDir: join(root, "out", "app-runtime") });

function nodeBin(packageName, ...parts) {
  return join(root, "node_modules", packageName, ...parts);
}
