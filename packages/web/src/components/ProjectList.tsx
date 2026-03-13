import { useEffect, useState } from "react";
import { fetchProjects } from "../api";
import { getProjectName, formatRelativeTime } from "../utils/format";
import { useSessionSync } from "../hooks/useSessionSync";
import type { ProjectListItem } from "@qoder-anywhere/shared";
import type { SelectedProject } from "../App";
import "./ProjectList.css";

interface ProjectListProps {
  selectedCwd: string | null;
  onSelect: (project: SelectedProject) => void;
}

export function ProjectList({ selectedCwd, onSelect }: ProjectListProps) {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { activeSessionCountByCwd, activeTerminalCountByCwd, synced } =
    useSessionSync();

  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((data) => {
        if (!cancelled) {
          setProjects(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div className="project-list-status">Loading projects...</div>;
  }

  if (error) {
    return (
      <div className="project-list-status project-list-error">{error}</div>
    );
  }

  if (projects.length === 0) {
    return <div className="project-list-status">No projects found</div>;
  }

  return (
    <div className="project-list">
      <div className="project-list-header">Projects</div>
      {projects.map((p) => {
        const name = getProjectName(p.cwd);
        const isSelected = p.cwd === selectedCwd;

        // Once WS is synced, use real-time counts (defaulting to 0);
        // before sync, fall back to REST snapshot
        const activeCount = synced
          ? (activeSessionCountByCwd.get(p.cwd) ?? 0)
          : p.activeSessionCount;
        const terminalCount = synced
          ? (activeTerminalCountByCwd.get(p.cwd) ?? 0)
          : p.activeTerminalCount;

        return (
          <button
            key={p.cwd}
            className={`project-list-item ${isSelected ? "project-list-item--selected" : ""}`}
            onClick={() => onSelect({ cwd: p.cwd, name })}
          >
            <div className="project-list-item-name">{name}</div>
            <div className="project-list-item-meta">
              {p.sessionCount} session{p.sessionCount !== 1 ? "s" : ""}
              {activeCount > 0 && (
                <>
                  {" "}
                  &middot;{" "}
                  <span className="project-list-active-badge">
                    {activeCount} active
                  </span>
                </>
              )}
              {terminalCount > 0 && (
                <>
                  {" "}
                  &middot;{" "}
                  <span className="project-list-terminal-badge">
                    {terminalCount} terminal{terminalCount !== 1 ? "s" : ""}
                  </span>
                </>
              )}{" "}
              &middot; {formatRelativeTime(p.lastModified)}
            </div>
          </button>
        );
      })}
    </div>
  );
}
