/**
 * Utility functions for path hashing, config dir resolution,
 * and JSONL parsing.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Convert a cwd path to the project directory name used by qodercli.
 *
 * qodercli replaces `/` with `-` and strips the leading `/`.
 * e.g. `/Users/jiamingmao/repos/foo` → `-Users-jiamingmao-repos-foo`
 *
 * Note: The leading `-` is preserved because stripping `/` from `/Users/...`
 * yields `-Users-...` (the first char becomes `-`).
 */
export function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/**
 * Resolve the qoder config directory.
 * Default: ~/.qoder
 */
export function resolveConfigDir(configDir?: string): string {
  return configDir ?? join(homedir(), ".qoder");
}

/**
 * Resolve the projects directory inside the config dir.
 */
export function resolveProjectsDir(configDir?: string): string {
  return join(resolveConfigDir(configDir), "projects");
}

/**
 * Parse a single JSONL line into a typed object.
 * Returns null if the line is empty or unparseable.
 */
export function parseJsonLine<T>(line: string): T | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

/**
 * Parse all lines in a JSONL string into an array of typed objects.
 * Skips empty lines and lines that fail to parse.
 */
export function parseJsonLines<T>(content: string): T[] {
  const results: T[] = [];
  for (const line of content.split("\n")) {
    const parsed = parseJsonLine<T>(line);
    if (parsed !== null) {
      results.push(parsed);
    }
  }
  return results;
}
