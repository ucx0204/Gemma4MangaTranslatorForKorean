const { existsSync, openSync, readSync, statSync, watchFile, closeSync } = require("node:fs");
const { dirname, join } = require("node:path");

const logPath = process.env.MANGA_TRANSLATOR_LOG_PATH || join(process.cwd(), "logs", "app.log");

console.log(`Tailing ${logPath}`);
console.log("Press Ctrl+C to stop.");

let position = existsSync(logPath) ? statSync(logPath).size : 0;

watchFile(logPath, { interval: 500 }, (current, previous) => {
  if (!existsSync(logPath)) {
    return;
  }

  if (current.size < position || current.size < previous.size) {
    position = 0;
  }

  if (current.size <= position) {
    return;
  }

  const fd = openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(current.size - position);
    readSync(fd, buffer, 0, buffer.length, position);
    position = current.size;
    process.stdout.write(buffer.toString("utf8"));
  } finally {
    closeSync(fd);
  }
});

if (!existsSync(dirname(logPath))) {
  console.log("Log directory does not exist yet. Start the app to create it.");
} else if (!existsSync(logPath)) {
  console.log("Log file does not exist yet. Start the app to create it.");
}
