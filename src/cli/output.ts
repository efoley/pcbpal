import * as clack from "@clack/prompts";
import { isInteractive, isJson } from "./context.js";

/**
 * Run an async operation with a spinner in interactive mode,
 * silently in batch mode.
 */
export async function runWithSpinner<T>(fn: () => Promise<T>, message: string): Promise<T> {
  if (isInteractive()) {
    const s = clack.spinner();
    s.start(message);
    try {
      const result = await fn();
      s.stop("Done");
      return result;
    } catch (e) {
      s.stop("Failed");
      throw e;
    }
  }
  return fn();
}

/**
 * Output a result in the appropriate format.
 * In JSON mode: serialize to stdout.
 * In interactive/plain mode: call the provided render function.
 */
export function output<T>(result: T, render: (result: T) => void): void {
  if (isJson()) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    render(result);
  }
}

/**
 * Report an error and exit.
 * In JSON mode: structured error object.
 * In interactive mode: styled error message.
 */
export function fatal(message: string, details?: Record<string, unknown>): never {
  if (isJson()) {
    console.log(JSON.stringify({ ok: false, error: message, ...details }));
  } else {
    clack.log.error(message);
    if (details) console.error(details);
  }
  process.exit(1);
}
