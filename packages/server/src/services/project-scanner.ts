import type { ProjectListItem } from "@lgtm-anywhere/shared";
import { SessionManager } from "./session-manager.js";

export async function scanProjects(
  sessionManager: SessionManager,
): Promise<ProjectListItem[]> {
  let sessions: Array<{
    sessionId: string;
    title?: string;
    updatedAt?: number;
    workingDir?: string;
  }>;

  try {
    sessions = await sessionManager.listSessions({});
  } catch {
    // If session files are not available, return empty
    sessions = [];
  }

  // Aggregate sessions by cwd
  const projectMap = new Map<
    string,
    { sessionCount: number; lastModified: number }
  >();

  for (const s of sessions) {
    const cwd = s.workingDir ?? "";
    if (!cwd) continue;

    const existing = projectMap.get(cwd);
    const lastModified = s.updatedAt ?? 0;
    if (existing) {
      existing.sessionCount++;
      if (lastModified > existing.lastModified) {
        existing.lastModified = lastModified;
      }
    } else {
      projectMap.set(cwd, {
        sessionCount: 1,
        lastModified,
      });
    }
  }

  const projects: ProjectListItem[] = [];
  for (const [cwd, info] of projectMap) {
    projects.push({
      cwd,
      ...info,
      activeSessionCount: 0,
      activeTerminalCount: 0,
    });
  }

  // Sort by lastModified descending
  projects.sort((a, b) => b.lastModified - a.lastModified);
  return projects;
}
