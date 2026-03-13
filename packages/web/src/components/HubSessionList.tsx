import { useEffect, useState, useCallback } from "react";
import { fetchNodeSessions } from "../api";
import { formatRelativeTime } from "../utils/format";
import type { SessionSummary, SessionState } from "@qoder-anywhere/shared";
import "./SessionList.css";

interface HubSessionListProps {
  nodeId: string;
  cwd: string;
  projectName: string;
  selectedSessionId: string | null;
  onSelect: (sessionId: string, summary: string) => void;
  onNewSession: () => void;
}

const STATE_LABELS: Record<SessionState, string> = {
  active: "Active",
  idle: "Idle",
  inactive: "Inactive",
};

export function HubSessionList({
  nodeId,
  cwd,
  projectName,
  selectedSessionId,
  onSelect,
  onNewSession,
}: HubSessionListProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [prevKey, setPrevKey] = useState(`${nodeId}:${cwd}`);
  const currentKey = `${nodeId}:${cwd}`;
  if (prevKey !== currentKey) {
    setPrevKey(currentKey);
    setLoading(true);
    setError(null);
  }

  const load = useCallback(() => {
    fetchNodeSessions(nodeId, cwd)
      .then((data) => {
        setSessions(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [nodeId, cwd]);

  useEffect(() => {
    load();
  }, [load]);

  // Periodically refresh
  useEffect(() => {
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="session-list">
      <div className="session-list-header">
        <span className="session-list-header-title">{projectName}</span>
        <button className="session-list-new-btn" onClick={onNewSession}>
          + New
        </button>
      </div>

      {loading && (
        <div className="session-list-status">Loading sessions...</div>
      )}
      {error && (
        <div className="session-list-status session-list-error">{error}</div>
      )}
      {!loading && !error && sessions.length === 0 && (
        <div className="session-list-status">No sessions yet</div>
      )}

      {sessions.map((s) => {
        const isSelected = s.sessionId === selectedSessionId;
        const liveState = s.state;
        return (
          <button
            key={s.sessionId}
            className={`session-list-item ${isSelected ? "session-list-item--selected" : ""}`}
            onClick={() =>
              onSelect(s.sessionId, s.summary || s.sessionId.slice(0, 8))
            }
          >
            <div className="session-list-item-top">
              <span
                className={`session-list-dot session-list-dot--${liveState}`}
                title={STATE_LABELS[liveState]}
              />
              <span className="session-list-item-summary">
                {s.summary || s.sessionId.slice(0, 8)}
              </span>
            </div>
            <div className="session-list-item-meta">
              {STATE_LABELS[liveState]} &middot;{" "}
              {formatRelativeTime(s.lastModified)}
            </div>
          </button>
        );
      })}
    </div>
  );
}
