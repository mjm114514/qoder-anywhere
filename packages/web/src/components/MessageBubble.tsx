import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ContentBlock } from "../hooks/useSessionSocket";
import "./MessageBubble.css";

interface MessageBubbleProps {
  message: ChatMessage;
  cwd?: string;
}

export function MessageBubble({ message, cwd }: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <div className="message-bubble message-bubble--user">
        <div className="message-bubble-content">{message.content}</div>
      </div>
    );
  }

  // Assistant message: render as timeline of blocks
  // Group: pair each tool_use with its subsequent tool_result
  const items = buildTimelineItems(message.blocks);

  return (
    <div className="message-bubble message-bubble--assistant">
      {items.map((item, i) => (
        <TimelineItem
          key={i}
          item={item}
          isStreaming={i === items.length - 1 && !!message.isStreaming}
          cwd={cwd}
        />
      ))}
      {items.length === 0 && message.isStreaming && (
        <div className="timeline-item">
          <div className="timeline-dot" />
          <div className="timeline-content">
            <span className="timeline-streaming">Thinking...</span>
          </div>
        </div>
      )}
    </div>
  );
}

type TimelineEntry =
  | { type: "text"; text: string }
  | {
      type: "tool";
      name: string;
      toolUseId: string;
      input?: unknown;
      result?: string;
    };

function buildTimelineItems(blocks: ContentBlock[]): TimelineEntry[] {
  const items: TimelineEntry[] = [];
  const resultMap = new Map<string, string>();

  // First pass: collect all tool_results by toolUseId
  for (const b of blocks) {
    if (b.type === "tool_result") {
      resultMap.set(b.toolUseId, b.content);
    }
  }

  // Second pass: build timeline
  for (const b of blocks) {
    if (b.type === "text") {
      if (b.text.trim()) {
        items.push({ type: "text", text: b.text });
      }
    } else if (b.type === "tool_use") {
      // Skip TodoWrite — displayed in the dedicated TodoPanel instead
      if (b.name === "TodoWrite") continue;
      items.push({
        type: "tool",
        name: b.name,
        toolUseId: b.toolUseId,
        input: b.input,
        result: resultMap.get(b.toolUseId),
      });
    }
    // tool_result blocks are consumed via resultMap, not rendered standalone
  }

  return items;
}

function TimelineItem({
  item,
  isStreaming,
  cwd,
}: {
  item: TimelineEntry;
  isStreaming: boolean;
  cwd?: string;
}) {
  if (item.type === "text") {
    return (
      <div className="timeline-item">
        <div className="timeline-dot" />
        <div className="timeline-content timeline-text">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
          {isStreaming && <span className="timeline-streaming-cursor" />}
        </div>
      </div>
    );
  }

  return <ToolBlock item={item} cwd={cwd} />;
}

function ToolBlock({
  item,
  cwd,
}: {
  item: TimelineEntry & { type: "tool" };
  cwd?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const inputSummary = formatToolInput(item.name, item.input, cwd);

  return (
    <div className="timeline-item">
      <div className="timeline-dot timeline-dot--tool" />
      <div className="timeline-content">
        <div className="tool-header" onClick={() => setExpanded(!expanded)}>
          <span className="tool-name">{item.name}</span>
          {inputSummary && (
            <span className="tool-input-summary">{inputSummary}</span>
          )}
          <span
            className={`tool-chevron ${expanded ? "tool-chevron--open" : ""}`}
          >
            &#9656;
          </span>
        </div>
        {expanded && (
          <div className="tool-detail">
            {item.input !== undefined && (
              <div className="tool-input">
                <pre>{JSON.stringify(item.input, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
        {item.result && <ToolResult content={item.result} />}
      </div>
    </div>
  );
}

function ToolResult({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = content.length > 200;
  const display = expanded ? content : content.slice(0, 200);

  return (
    <div className="tool-result">
      <pre>
        {display}
        {truncated && !expanded && "..."}
      </pre>
      {truncated && (
        <button
          className="tool-result-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** Strip cwd prefix from a file path for shorter display. */
function stripCwd(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
  if (filePath.startsWith(prefix)) {
    return filePath.slice(prefix.length);
  }
  return filePath;
}

/** Format a short summary of tool input for the header line. */
function formatToolInput(_name: string, input: unknown, cwd?: string): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;

  // Common patterns for Claude tool calls
  if (typeof obj.command === "string") return truncate(obj.command, 60);
  if (typeof obj.file_path === "string")
    return truncate(stripCwd(obj.file_path, cwd), 60);
  if (typeof obj.path === "string")
    return truncate(stripCwd(obj.path, cwd), 60);
  if (typeof obj.pattern === "string") return truncate(obj.pattern, 60);
  if (typeof obj.query === "string") return truncate(obj.query, 60);
  if (typeof obj.url === "string") return truncate(obj.url, 60);
  if (typeof obj.prompt === "string") return truncate(obj.prompt, 60);

  // For tools with a "name" sub-param (like Read with file_path)
  const firstStringVal = Object.values(obj).find(
    (v) => typeof v === "string",
  ) as string | undefined;
  if (firstStringVal) return truncate(firstStringVal, 60);

  return "";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
