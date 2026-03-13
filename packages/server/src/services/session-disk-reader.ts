/**
 * Disk-based session reader — reads session metadata directly from
 * qodercli's on-disk storage instead of going through ACP.
 *
 * Session data lives in:
 *   ~/.qoder/projects/<hashed-cwd>/<uuid>-session.json   (metadata)
 *   ~/.qoder/projects/<hashed-cwd>/<uuid>.jsonl           (transcript)
 *
 * The hashed-cwd is the cwd with all `/` replaced by `-`.
 * e.g. `/Users/foo/repos/bar` → `-Users-foo-repos-bar`
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ──

/** Raw on-disk JSON shape of *-session.json files. */
export interface RawSessionJson {
  id: string;
  parent_session_id: string;
  title: string;
  message_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  created_at: number;
  updated_at: number;
  working_dir: string;
  quest: boolean;
  total_prompt_tokens: number;
  total_completed_tokens: number;
  total_cached_tokens: number;
  total_model_call_times: number;
  total_tool_call_times: number;
  context_usage_ratio: number;
}

/** Parsed session info returned by the reader. */
export interface DiskSessionInfo {
  sessionId: string;
  title: string;
  workingDir: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// ── Path helpers ──

/** Convert a cwd path to the project directory name used by qodercli. */
function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/** Resolve the projects directory: ~/.qoder/projects/ */
function resolveProjectsDir(): string {
  return join(homedir(), ".qoder", "projects");
}

// ── Core reader ──

/** Parse a raw session JSON into DiskSessionInfo. */
function parseSessionInfo(raw: RawSessionJson): DiskSessionInfo {
  return {
    sessionId: raw.id,
    title: raw.title,
    workingDir: raw.working_dir,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    messageCount: raw.message_count,
  };
}

/** Read all *-session.json files from a single project directory. */
async function readProjectSessions(
  projectPath: string,
): Promise<DiskSessionInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(projectPath);
  } catch {
    return [];
  }

  const sessionFiles = entries.filter((f) => f.endsWith("-session.json"));

  const results = await Promise.allSettled(
    sessionFiles.map(async (file) => {
      const content = await readFile(join(projectPath, file), "utf-8");
      const raw = JSON.parse(content) as RawSessionJson;
      return parseSessionInfo(raw);
    }),
  );

  const sessions: DiskSessionInfo[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      sessions.push(result.value);
    }
  }
  return sessions;
}

/**
 * List sessions from disk, optionally filtered by working directory.
 *
 * - If `cwd` is provided, reads only the matching project directory.
 * - Otherwise scans all project directories under ~/.qoder/projects/.
 */
export async function listSessionsFromDisk(options?: {
  cwd?: string;
}): Promise<DiskSessionInfo[]> {
  const projectsDir = resolveProjectsDir();

  if (options?.cwd) {
    const dirName = cwdToProjectDir(options.cwd);
    const projectPath = join(projectsDir, dirName);
    return readProjectSessions(projectPath);
  }

  // Scan all project directories
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  const allSessions: DiskSessionInfo[] = [];

  const results = await Promise.allSettled(
    projectDirs.map((dir) => readProjectSessions(join(projectsDir, dir))),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      allSessions.push(...result.value);
    }
  }

  // Sort by updatedAt descending (most recent first)
  allSessions.sort((a, b) => b.updatedAt - a.updatedAt);

  return allSessions;
}
