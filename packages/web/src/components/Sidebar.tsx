import { ProjectList } from "./ProjectList";
import { SessionList } from "./SessionList";
import { NodeList } from "./NodeList";
import { HubSessionList } from "./HubSessionList";
import { useHubMode } from "../hooks/useHubMode";
import type { SelectedProject } from "../App";
import "./Sidebar.css";

interface SidebarProps {
  selectedProject: SelectedProject | null;
  selectedSessionId: string | null;
  selectedNodeId: string | null;
  onSelectProject: (project: SelectedProject) => void;
  onSelectNodeProject: (nodeId: string, project: SelectedProject) => void;
  onSelectSession: (sessionId: string, summary: string) => void;
  onNewSession: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function Sidebar({
  selectedProject,
  selectedSessionId,
  selectedNodeId,
  onSelectProject,
  onSelectNodeProject,
  onSelectSession,
  onNewSession,
  collapsed,
  onToggleCollapse,
}: SidebarProps) {
  const { isHub } = useHubMode();

  return (
    <aside className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}>
      <div className="sidebar-header">
        {!collapsed && (
          <h1 className="sidebar-title">
            {isHub ? "Qoder Hub" : "Qoder Anywhere"}
          </h1>
        )}
        <button
          className="sidebar-toggle"
          onClick={onToggleCollapse}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? "›" : "‹"}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="sidebar-upper">
            {isHub ? (
              <NodeList
                selectedNodeId={selectedNodeId}
                selectedCwd={selectedProject?.cwd ?? null}
                onSelectProject={onSelectNodeProject}
              />
            ) : (
              <ProjectList
                selectedCwd={selectedProject?.cwd ?? null}
                onSelect={onSelectProject}
              />
            )}
          </div>
          <div className="sidebar-lower">
            {selectedProject ? (
              isHub && selectedNodeId ? (
                <HubSessionList
                  nodeId={selectedNodeId}
                  cwd={selectedProject.cwd}
                  projectName={selectedProject.name}
                  selectedSessionId={selectedSessionId}
                  onSelect={onSelectSession}
                  onNewSession={onNewSession}
                />
              ) : !isHub ? (
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
              )
            ) : (
              <div className="sidebar-placeholder">
                {isHub
                  ? "Select a node and project to view sessions"
                  : "Select a project to view sessions"}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
