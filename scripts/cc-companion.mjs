#!/usr/bin/env node

const [command = "setup"] = process.argv.slice(2);

if (command === "setup") {
  console.log("# Claude Code Plugin Setup");
  console.log("");
  console.log("The companion runtime will be implemented in later tasks.");
  process.exit(0);
}

console.error(`Command not implemented yet: ${command}`);
process.exit(1);
