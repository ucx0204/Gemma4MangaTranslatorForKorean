const { copyFileSync, existsSync, mkdirSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

function prepareRuntimeAssets(options = {}) {
  const root = options.root ?? join(__dirname, "..");
  const sourceDir = join(root, "src", "main", "runtime");
  const outputDir = options.outputDir ?? join(root, "out", "app-runtime");

  if (!existsSync(sourceDir)) {
    throw new Error(`Runtime source directory is missing: ${sourceDir}`);
  }

  mkdirSync(outputDir, { recursive: true });

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    copyFileSync(join(sourceDir, entry.name), join(outputDir, entry.name));
  }

  return outputDir;
}

module.exports = {
  prepareRuntimeAssets
};

if (require.main === module) {
  const outputDir = prepareRuntimeAssets();
  console.log(`[runtime] prepared ${outputDir}`);
}
