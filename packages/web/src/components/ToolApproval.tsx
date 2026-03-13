import { useState } from "react";
import type { PermissionMode } from "@lgtm-anywhere/shared";
import type { PendingToolApproval } from "../hooks/useSessionSocket";
import "./ToolApproval.css";

interface ToolApprovalProps {
  pendingToolApproval: PendingToolApproval;
  onAnswer: (
    requestId: string,
    decision: "allow" | "deny",
    denyMessage?: string,
  ) => void;
  onSetPermissionMode?: (mode: PermissionMode) => void;
}

const MAX_VALUE_LENGTH = 200;

function truncateValue(value: unknown): string {
  const str =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (str.length > MAX_VALUE_LENGTH) {
    return str.slice(0, MAX_VALUE_LENGTH) + "...";
  }
  return str;
}

const EXIT_PLAN_MODE_OPTIONS: {
  label: string;
  fullLabel: string;
  mode: PermissionMode;
  color: string;
}[] = [
  {
    label: "Default",
    fullLabel: "Approve the plan and switch to Default mode",
    mode: "default",
    color: "#1976d2",
  },
  {
    label: "YOLO",
    fullLabel: "Approve the plan and switch to YOLO mode",
    mode: "yolo",
    color: "#d32f2f",
  },
];

export function ToolApproval({
  pendingToolApproval,
  onAnswer,
  onSetPermissionMode,
}: ToolApprovalProps) {
  const { requestId, toolName, input, decisionReason } = pendingToolApproval;
  const [denyText, setDenyText] = useState("");

  const isExitPlanMode = toolName === "ExitPlanMode";

  const inputEntries = Object.entries(input).filter(
    ([key]) => key !== "tool_use_id",
  );

  // Pick the first meaningful value as a summary line
  const summaryEntry = inputEntries[0];
  const summaryText = summaryEntry ? truncateValue(summaryEntry[1]) : undefined;

  const handleAllowWithMode = (mode: PermissionMode) => {
    onAnswer(requestId, "allow");
    onSetPermissionMode?.(mode);
  };

  const handleDenyWithMessage = () => {
    onAnswer(requestId, "deny", denyText.trim() || undefined);
    setDenyText("");
  };

  if (isExitPlanMode) {
    return (
      <div className="tool-approval tool-approval--exit-plan">
        <div className="tool-approval-ep-header">
          Approve plan and switch mode
        </div>
        {decisionReason && (
          <div className="tool-approval-reason">{decisionReason}</div>
        )}
        <div className="tool-approval-ep-options">
          {EXIT_PLAN_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.mode}
              className="tool-approval-ep-option"
              onClick={() => handleAllowWithMode(opt.mode)}
            >
              <span
                className="tool-approval-ep-dot"
                style={{ background: opt.color }}
              />
              <span className="tool-approval-ep-option-full">
                {opt.fullLabel}
              </span>
              <span className="tool-approval-ep-option-short">{opt.label}</span>
            </button>
          ))}
        </div>
        <div className="tool-approval-ep-reject">
          <input
            className="tool-approval-ep-reject-input"
            type="text"
            placeholder="Reject with feedback..."
            value={denyText}
            onChange={(e) => setDenyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleDenyWithMessage();
            }}
          />
          <button
            className="tool-approval-ep-reject-btn"
            onClick={handleDenyWithMessage}
          >
            Reject
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="tool-approval">
      <div className="tool-approval-row">
        <span className="tool-approval-dot" />
        <div className="tool-approval-body">
          <div className="tool-approval-top">
            <span className="tool-approval-name">{toolName}</span>
            {summaryText && (
              <span className="tool-approval-summary">{summaryText}</span>
            )}
          </div>
          {decisionReason && (
            <div className="tool-approval-reason">{decisionReason}</div>
          )}
          {inputEntries.length > 1 && (
            <div className="tool-approval-params">
              {inputEntries.slice(1).map(([key, value]) => (
                <div key={key} className="tool-approval-param">
                  <span className="tool-approval-param-key">{key}:</span>{" "}
                  <span className="tool-approval-param-val">
                    {truncateValue(value)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="tool-approval-actions">
            <button
              className="tool-approval-btn tool-approval-btn--deny"
              onClick={() => onAnswer(requestId, "deny")}
            >
              Deny
            </button>
            <button
              className="tool-approval-btn tool-approval-btn--allow"
              onClick={() => onAnswer(requestId, "allow")}
            >
              Allow
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
