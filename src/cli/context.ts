export function isInteractive(): boolean {
  return process.stdout.isTTY === true && !process.argv.includes("--json");
}

export function isJson(): boolean {
  return process.argv.includes("--json");
}
