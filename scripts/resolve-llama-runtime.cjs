const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

function binaryName() {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server";
}

function bundledServerCandidates(root) {
  const serverBinary = binaryName();
  return [
    join(root, "tools", "llama-b8833-cuda12.4", serverBinary),
    join(root, "tools", "llama-b8833-cuda13.1", serverBinary),
    join(root, "tools", "llama-b8808-cuda12", serverBinary)
  ];
}

function hasCudaBackend(serverPath) {
  const runtimeDir = dirname(serverPath);
  return [
    "ggml-cuda.dll",
    "ggml-cuda-cu12.dll",
    "ggml-cuda-cu13.dll"
  ].some((fileName) => existsSync(join(runtimeDir, fileName)));
}

function resolveBundledServerPath(root) {
  const candidates = bundledServerCandidates(root).filter((candidate) => existsSync(candidate));
  return candidates.find((candidate) => hasCudaBackend(candidate))
    ?? candidates[0]
    ?? bundledServerCandidates(root)[0];
}

module.exports = {
  bundledServerCandidates,
  hasCudaBackend,
  resolveBundledServerPath
};
