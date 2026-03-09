import { useState, useRef, type KeyboardEvent } from "react";
import "./ChatInput.css";

const MODEL_OPTIONS = [
  { label: "Auto", value: "" },
  { label: "Opus", value: "claude-opus-4-6" },
  { label: "Sonnet", value: "claude-sonnet-4-6" },
  { label: "Haiku", value: "claude-haiku-4-5-20251001" },
];

interface ChatInputProps {
  onSend: (text: string, model?: string) => void;
  disabled: boolean;
  placeholder?: string;
}

export function ChatInput({
  onSend,
  disabled,
  placeholder,
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed, model || undefined);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.overflowY = "hidden";
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      // 5 lines max: lineHeight(21px) * 5 + padding(20px) = 125px
      const maxHeight = 125;
      el.style.height = Math.min(el.scrollHeight, maxHeight) + "px";
      el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
    }
  };

  const defaultPlaceholder = disabled
    ? "Waiting for response..."
    : "Type a message... (Ctrl+Enter to send)";

  return (
    <div className="chat-input">
      <select
        className="chat-input-model"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        disabled={disabled}
      >
        {MODEL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <textarea
        ref={textareaRef}
        className="chat-input-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        placeholder={placeholder ?? defaultPlaceholder}
        disabled={disabled}
        rows={1}
      />
      <button
        className="chat-input-send"
        onClick={handleSend}
        disabled={disabled || !text.trim()}
      >
        Send
      </button>
    </div>
  );
}
