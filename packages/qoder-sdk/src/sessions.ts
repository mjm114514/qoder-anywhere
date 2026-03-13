/**
 * Session management — filesystem reads of qodercli's session storage.
 *
 * Session data lives in:
 *   ~/.qoder/projects/<hashed-cwd>/<uuid>-session.json   (metadata)
 *   ~/.qoder/projects/<hashed-cwd>/<uuid>.jsonl           (transcript)
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  QoderSessionInfo,
  QoderSessionMessage,
  RawSessionJson,
  ListSessionsOptions,
  GetSessionMessagesOptions,
} from "./types.js";
import {
  cwdToProjectDir,
  resolveProjectsDir,
  parseJsonLines,
} from "./utils.js";

/**
 * Parse a raw session JSON file into a QoderSessionInfo.
 */
function parseSessionInfo(raw: RawSessionJson): QoderSessionInfo {
  return {
    sessionId: raw.id,
    parentSessionId: raw.parent_session_id,
    title: raw.title,
    workingDir: raw.working_dir,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    messageCount: raw.message_count,
    promptTokens: raw.prompt_tokens,
    completionTokens: raw.completion_tokens,
    cost: raw.cost,
    totalPromptTokens: raw.total_prompt_tokens,
    totalCompletedTokens: raw.total_completed_tokens,
    totalCachedTokens: raw.total_cached_tokens,
    totalModelCallTimes: raw.total_model_call_times,
    totalToolCallTimes: raw.total_tool_call_times,
    contextUsageRatio: raw.context_usage_ratio,

    // Claude Agent SDK compatibility aliases
    summary: raw.title,
    lastModified: raw.updated_at,
    fileSize: 0,
    cwd: raw.working_dir,
    gitBranch: undefined,
    customTitle: undefined,
    firstPrompt: undefined,
  };
}

/**
 * Augment a raw-parsed session message with Claude Agent SDK compatibility fields.
 */
function augmentSessionMessage(
  raw: Omit<QoderSessionMessage, "session_id" | "parent_tool_use_id">,
): QoderSessionMessage {
  return {
    ...raw,
    session_id: raw.sessionId,
    parent_tool_use_id: null,
  } as QoderSessionMessage;
}

/**
 * Read all *-session.json files from a single project directory.
 */
async function readProjectSessions(
  projectPath: string,
): Promise<QoderSessionInfo[]> {
  const sessions: QoderSessionInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(projectPath);
  } catch {
    return sessions;
  }

  const sessionFiles = entries.filter((f) => f.endsWith("-session.json"));

  const results = await Promise.allSettled(
    sessionFiles.map(async (file) => {
      const content = await readFile(join(projectPath, file), "utf-8");
      const raw = JSON.parse(content) as RawSessionJson;
      return parseSessionInfo(raw);
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      sessions.push(result.value);
    }
  }

  return sessions;
}

/**
 * List all sessions, optionally filtered by working directory.
 *
 * Scans `~/.qoder/projects/` for `*-session.json` files.
 *
 * @example
 * ```ts
 * // List all sessions
 * const all = await listSessions();
 *
 * // List sessions for a specific directory
 * const projectSessions = await listSessions({ dir: "/Users/me/repos/myproject" });
 * ```
 */
export async function listSessions(
  options: ListSessionsOptions = {},
): Promise<QoderSessionInfo[]> {
  const projectsDir = resolveProjectsDir(options.configDir);

  if (options.dir) {
    // Read sessions from a specific project directory
    const dirName = cwdToProjectDir(options.dir);
    const projectPath = join(projectsDir, dirName);
    const sessions = await readProjectSessions(projectPath);

    // Apply limit if specified
    if (options.limit !== undefined && options.limit >= 0) {
      return sessions.slice(0, options.limit);
    }

    return sessions;
  }

  // Scan all project directories
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  const allSessions: QoderSessionInfo[] = [];

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

  // Apply limit if specified
  if (options.limit !== undefined && options.limit >= 0) {
    return allSessions.slice(0, options.limit);
  }

  return allSessions;
}

/**
 * Find the project directory containing a session by its ID.
 * Scans all project directories for a matching *-session.json file.
 */
async function findSessionProjectDir(
  sessionId: string,
  projectsDir: string,
): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return null;
  }

  for (const dir of projectDirs) {
    const projectPath = join(projectsDir, dir);
    let entries: string[];
    try {
      entries = await readdir(projectPath);
    } catch {
      continue;
    }
    const sessionFile = `${sessionId}-session.json`;
    if (entries.includes(sessionFile)) {
      return projectPath;
    }
  }

  return null;
}

/**
 * Read the message transcript for a session.
 *
 * Reads `~/.qoder/projects/<hashed-cwd>/<sessionId>.jsonl` and parses
 * each line into a QoderSessionMessage.
 *
 * @example
 * ```ts
 * const messages = await getSessionMessages("abc-123-def", {
 *   dir: "/Users/me/repos/myproject",
 * });
 * for (const msg of messages) {
 *   console.log(`[${msg.type}] ${msg.uuid}`);
 * }
 * ```
 */
export async function getSessionMessages(
  sessionId: string,
  options: GetSessionMessagesOptions = {},
): Promise<QoderSessionMessage[]> {
  const projectsDir = resolveProjectsDir(options.configDir);

  let projectPath: string;

  if (options.dir) {
    const dirName = cwdToProjectDir(options.dir);
    projectPath = join(projectsDir, dirName);
  } else {
    // Search all project directories for this session
    const found = await findSessionProjectDir(sessionId, projectsDir);
    if (!found) {
      throw new Error(
        `Session ${sessionId} not found. Provide a 'dir' option to narrow the search.`,
      );
    }
    projectPath = found;
  }

  const jsonlPath = join(projectPath, `${sessionId}.jsonl`);

  let content: string;
  try {
    content = await readFile(jsonlPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read session transcript at ${jsonlPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rawMessages = parseJsonLines<QoderSessionMessage>(content);
  const messages = rawMessages.map(augmentSessionMessage);

  // Apply offset and limit if specified
  const start = options.offset ?? 0;
  if (start > 0 || options.limit !== undefined) {
    const end = options.limit !== undefined ? start + options.limit : undefined;
    return messages.slice(start, end);
  }

  return messages;
}
