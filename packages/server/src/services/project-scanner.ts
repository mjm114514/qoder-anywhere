import { listSessions } from "qoder-sdk";
import type { ProjectListItem } from "@lgtm-anywhere/shared";

export async function scanProjects(): Promise<ProjectListItem[]> {
  const sessions = await listSessions({});

  // Aggregate sessions by cwd
  const projectMap = new Map<
    string,
    { sessionCount: number; lastModified: number }
  >();

  for (const s of sessions) {
    const cwd = s.cwd ?? "";
    if (!cwd) continue;

    const existing = projectMap.get(cwd);
    if (existing) {
      existing.sessionCount++;
      if (s.lastModified > existing.lastModified) {
        existing.lastModified = s.lastModified;
      }
    } else {
      projectMap.set(cwd, {
        sessionCount: 1,
        lastModified: s.lastModified,
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
