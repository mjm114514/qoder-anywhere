import { useImperativeHandle, forwardRef, useRef, useEffect, useCallback } from "react";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "../hooks/useSessionSocket";
import "./MessageList.css";

interface MessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  cwd?: string;
}

export interface MessageListHandle {
  scrollToBottom: () => void;
}

const NEAR_BOTTOM_THRESHOLD = 80;

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  function MessageList({ messages, isStreaming, cwd }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const isNearBottomRef = useRef(true);

    const scrollToBottom = useCallback(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }, []);

    useImperativeHandle(ref, () => ({ scrollToBottom }));

    const handleScroll = useCallback(() => {
      const el = containerRef.current;
      if (!el) return;
      isNearBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD;
    }, []);

    // Auto-scroll when messages change, but only if user is near bottom
    useEffect(() => {
      if (isNearBottomRef.current) {
        endRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }, [messages]);

    if (messages.length === 0 && !isStreaming) {
      return (
        <div className="message-list-empty">
          No messages yet. Send a message to get started.
        </div>
      );
    }

    return (
      <div className="message-list" ref={containerRef} onScroll={handleScroll}>
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} cwd={cwd} />
        ))}
        <div ref={endRef} className="message-list-anchor" />
      </div>
    );
  }
);
