import { useEffect, useState, useCallback } from "react";
import { fetchSessions } from "../api";
import { formatRelativeTime } from "../utils/format";
import type { SessionSummary, SessionState } from "@lgtm-anywhere/shared";
import "./SessionList.css";

interface SessionListProps {
  cwd: string;
  projectName: string;
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNewSession: () => void;
}

const STATE_LABELS: Record<SessionState, string> = {
  active: "Active",
  idle: "Idle",
  inactive: "Inactive",
};

export function SessionList({
  cwd,
  projectName,
  selectedSessionId,
  onSelect,
  onNewSession,
}: SessionListProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchSessions(cwd)
      .then((data) => {
        setSessions(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [cwd]);

  useEffect(() => {
    load();
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
        return (
          <button
            key={s.sessionId}
            className={`session-list-item ${isSelected ? "session-list-item--selected" : ""}`}
            onClick={() => onSelect(s.sessionId)}
          >
            <div className="session-list-item-top">
              <span
                className={`session-list-dot session-list-dot--${s.state}`}
                title={STATE_LABELS[s.state]}
              />
              <span className="session-list-item-summary">
                {s.summary || s.sessionId.slice(0, 8)}
              </span>
            </div>
            <div className="session-list-item-meta">
              {STATE_LABELS[s.state]} &middot;{" "}
              {formatRelativeTime(s.lastModified)}
            </div>
          </button>
        );
      })}
    </div>
  );
}
