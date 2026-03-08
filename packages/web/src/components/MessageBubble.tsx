import type { ChatMessage } from "../hooks/useSessionSocket";
import "./MessageBubble.css";

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div
      className={`message-bubble ${isUser ? "message-bubble--user" : "message-bubble--assistant"}`}
    >
      <div className="message-bubble-role">
        {isUser ? "You" : "Assistant"}
        {message.isStreaming && (
          <span className="message-bubble-streaming"> (typing...)</span>
        )}
      </div>
      <div className="message-bubble-content">
        {message.content || (message.toolUse && `Using tool: ${message.toolUse.name}`)}
        {!message.content && !message.toolUse && (
          <span className="message-bubble-empty">(empty)</span>
        )}
      </div>
      {message.toolUse && message.content && (
        <div className="message-bubble-tool">
          Tool: {message.toolUse.name}
        </div>
      )}
      {message.toolResult && (
        <div className="message-bubble-tool-result">
          <details>
            <summary>Tool result</summary>
            <pre>{message.toolResult.content.slice(0, 500)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
