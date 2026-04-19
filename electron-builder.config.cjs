module.exports = {
  appId: "com.sam40.mangagemma.translator",
  productName: "망가번역기",
  directories: {
    output: "dist"
  },
  files: [
    "**/*",
    "!src{,/**/*}",
    "!tests{,/**/*}",
    "!scripts{,/**/*}",
    "!tools{,/**/*}",
    "!models{,/**/*}",
    "!library{,/**/*}",
    "!.venv-glmocr{,/**/*}",
    "!logs{,/**/*}",
    "!README.md",
    "!out/app-runtime{,/**/*}"
  ],
  extraResources: [
    {
      from: "out/app-runtime",
      to: "app-runtime"
    },
    {
      from: "tools/llama-b8833-cuda12.4",
      to: "tools/llama-b8833-cuda12.4"
    }
  ],
  asar: true,
  win: {
    target: [
      {
        target: "nsis",
        arch: ["x64"]
      }
    ]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false
  }
};
