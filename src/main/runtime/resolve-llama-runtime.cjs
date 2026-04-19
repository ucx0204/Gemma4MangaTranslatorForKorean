const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

function binaryName() {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server";
}

function bundledServerCandidates(toolsDir) {
  const serverBinary = binaryName();
  return [
    join(toolsDir, "llama-b8833-cuda12.4", serverBinary)
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

function resolveBundledServerPath(toolsDir) {
  const candidates = bundledServerCandidates(toolsDir).filter((candidate) => existsSync(candidate));
  return candidates.find((candidate) => hasCudaBackend(candidate))
    ?? candidates[0]
    ?? bundledServerCandidates(toolsDir)[0];
}

module.exports = {
  bundledServerCandidates,
  hasCudaBackend,
  resolveBundledServerPath
};
