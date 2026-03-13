import { useEffect, useState, useCallback } from "react";
import { fetchNodes, fetchNodeProjects } from "../api";
import { getProjectName, formatRelativeTime } from "../utils/format";
import type { NodeInfo, ProjectListItem } from "@qoder-anywhere/shared";
import type { SelectedProject } from "../App";
import "./NodeList.css";

interface NodeListProps {
  selectedNodeId: string | null;
  selectedCwd: string | null;
  onSelectProject: (nodeId: string, project: SelectedProject) => void;
}

interface NodeProjectsState {
  projects: ProjectListItem[];
  loading: boolean;
  error: string | null;
}

export function NodeList({
  selectedNodeId,
  selectedCwd,
  onSelectProject,
}: NodeListProps) {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [nodeProjects, setNodeProjects] = useState<
    Record<string, NodeProjectsState>
  >({});

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchNodes()
        .then((data) => {
          if (!cancelled) {
            setNodes(data);
            setLoading(false);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err.message);
            setLoading(false);
          }
        });
    };
    load();

    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const loadProjects = useCallback((nodeId: string) => {
    setNodeProjects((prev) => ({
      ...prev,
      [nodeId]: {
        projects: prev[nodeId]?.projects ?? [],
        loading: true,
        error: null,
      },
    }));
    fetchNodeProjects(nodeId)
      .then((projects) => {
        setNodeProjects((prev) => ({
          ...prev,
          [nodeId]: { projects, loading: false, error: null },
        }));
      })
      .catch((err) => {
        setNodeProjects((prev) => ({
          ...prev,
          [nodeId]: {
            projects: prev[nodeId]?.projects ?? [],
            loading: false,
            error: err.message,
          },
        }));
      });
  }, []);

  const toggleNode = (nodeId: string) => {
    const willExpand = !expanded[nodeId];
    setExpanded((prev) => ({ ...prev, [nodeId]: willExpand }));
    if (willExpand) {
      loadProjects(nodeId);
    }
  };

  if (loading) {
    return <div className="node-list-status">Loading nodes...</div>;
  }

  if (error) {
    return <div className="node-list-status node-list-error">{error}</div>;
  }

  if (nodes.length === 0) {
    return <div className="node-list-status">No nodes connected</div>;
  }

  return (
    <div className="node-list">
      <div className="node-list-header">Nodes</div>
      {nodes.map((node) => {
        const isExpanded = expanded[node.nodeId] ?? false;
        const isNodeSelected = node.nodeId === selectedNodeId;
        const projState = nodeProjects[node.nodeId];

        return (
          <div key={node.nodeId} className="node-list-node">
            <button
              className={`node-list-node-header ${isNodeSelected ? "node-list-node-header--selected" : ""}`}
              onClick={() => toggleNode(node.nodeId)}
            >
              <span
                className={`node-list-chevron ${isExpanded ? "node-list-chevron--open" : ""}`}
              >
                ›
              </span>
              <span className="node-list-node-icon">⬡</span>
              <div className="node-list-node-info">
                <div className="node-list-node-name">{node.name}</div>
              </div>
            </button>

            {isExpanded && (
              <div className="node-list-projects">
                {projState?.loading && !projState.projects.length ? (
                  <div className="node-list-no-projects">Loading...</div>
                ) : projState?.error && !projState.projects.length ? (
                  <div className="node-list-no-projects">{projState.error}</div>
                ) : !projState?.projects.length ? (
                  <div className="node-list-no-projects">No projects</div>
                ) : (
                  projState.projects.map((project: ProjectListItem) => {
                    const name = getProjectName(project.cwd);
                    const isProjectSelected =
                      isNodeSelected && project.cwd === selectedCwd;

                    return (
                      <button
                        key={project.cwd}
                        className={`node-list-project-item ${isProjectSelected ? "node-list-project-item--selected" : ""}`}
                        onClick={() =>
                          onSelectProject(node.nodeId, {
                            cwd: project.cwd,
                            name,
                          })
                        }
                      >
                        <div className="node-list-project-name">{name}</div>
                        <div className="node-list-project-meta">
                          {project.sessionCount} session
                          {project.sessionCount !== 1 ? "s" : ""}
                          {project.activeSessionCount > 0 && (
                            <>
                              {" · "}
                              <span className="node-list-active-badge">
                                {project.activeSessionCount} active
                              </span>
                            </>
                          )}
                          {" · "}
                          {formatRelativeTime(project.lastModified)}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
