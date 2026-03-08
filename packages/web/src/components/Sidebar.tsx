import { ProjectList } from "./ProjectList";
import { SessionList } from "./SessionList";
import type { SelectedProject } from "../App";
import "./Sidebar.css";

interface SidebarProps {
  selectedProject: SelectedProject | null;
  selectedSessionId: string | null;
  onSelectProject: (project: SelectedProject) => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
}

export function Sidebar({
  selectedProject,
  selectedSessionId,
  onSelectProject,
  onSelectSession,
  onNewSession,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1 className="sidebar-title">LGTM Anywhere</h1>
      </div>
      <div className="sidebar-upper">
        <ProjectList
          selectedCwd={selectedProject?.cwd ?? null}
          onSelect={onSelectProject}
        />
      </div>
      <div className="sidebar-lower">
        {selectedProject ? (
          <SessionList
            cwd={selectedProject.cwd}
            projectName={selectedProject.name}
            selectedSessionId={selectedSessionId}
            onSelect={onSelectSession}
            onNewSession={onNewSession}
          />
        ) : (
          <div className="sidebar-placeholder">
            Select a project to view sessions
          </div>
        )}
      </div>
    </aside>
  );
}
