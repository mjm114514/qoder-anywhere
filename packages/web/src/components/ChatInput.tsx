import {
  useState,
  useRef,
  useMemo,
  useCallback,
  type KeyboardEvent,
  type ClipboardEvent,
  type ChangeEvent,
} from "react";
import type { UserImageAttachment } from "@lgtm-anywhere/shared";
import "./ChatInput.css";

const MODEL_OPTIONS = [
  { label: "Auto", value: "" },
  { label: "Opus", value: "claude-opus-4-6" },
  { label: "Sonnet", value: "claude-sonnet-4-6" },
  { label: "Haiku", value: "claude-haiku-4-5-20251001" },
];

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Max image size in bytes (10 MB). Files larger than this are silently ignored. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface ChatInputProps {
  onSend: (
    text: string,
    model?: string,
    images?: UserImageAttachment[],
  ) => void;
  disabled: boolean;
  placeholder?: string;
}

export function ChatInput({ onSend, disabled, placeholder }: ChatInputProps) {
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const [images, setImages] = useState<UserImageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const shortcutLabel = useMemo(() => (isMac ? "⌘↵" : "Ctrl↵"), []);

  const handleSend = () => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    onSend(trimmed, model || undefined, images.length > 0 ? images : undefined);
    setText("");
    setImages([]);
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

  /** Read a File as a base64 UserImageAttachment. */
  const readFileAsAttachment = useCallback(
    (file: File): Promise<UserImageAttachment | null> => {
      if (!file.type.startsWith("image/")) return Promise.resolve(null);
      if (file.size > MAX_IMAGE_BYTES) return Promise.resolve(null);
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          // dataUrl is "data:<media_type>;base64,<data>"
          const commaIdx = dataUrl.indexOf(",");
          if (commaIdx === -1) {
            resolve(null);
            return;
          }
          resolve({
            media_type: file.type,
            data: dataUrl.slice(commaIdx + 1),
          });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    },
    [],
  );

  /** Handle paste events: intercept image data from clipboard. */
  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length === 0) return;

      // Prevent the default paste (which would insert garbage text)
      e.preventDefault();

      Promise.all(imageFiles.map(readFileAsAttachment)).then((results) => {
        const valid = results.filter(
          (r): r is UserImageAttachment => r !== null,
        );
        if (valid.length > 0) {
          setImages((prev) => [...prev, ...valid]);
        }
      });
    },
    [readFileAsAttachment],
  );

  /** Handle file input change (attach button). */
  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      Promise.all(Array.from(files).map(readFileAsAttachment)).then(
        (results) => {
          const valid = results.filter(
            (r): r is UserImageAttachment => r !== null,
          );
          if (valid.length > 0) {
            setImages((prev) => [...prev, ...valid]);
          }
        },
      );

      // Reset the file input so selecting the same file again triggers onChange
      e.target.value = "";
    },
    [readFileAsAttachment],
  );

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const defaultPlaceholder = disabled
    ? "Waiting for response..."
    : "Type a message...";

  return (
    <div className="chat-input">
      {images.length > 0 && (
        <div className="chat-input-image-strip">
          {images.map((img, i) => (
            <div className="chat-input-image-thumb" key={i}>
              <img
                src={`data:${img.media_type};base64,${img.data}`}
                alt={`Attachment ${i + 1}`}
              />
              <button
                className="chat-input-image-remove"
                onClick={() => removeImage(i)}
                title="Remove image"
                type="button"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="chat-input-row">
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
        <button
          className="chat-input-attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title="Attach image"
          type="button"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="chat-input-file-hidden"
          onChange={handleFileChange}
        />
        <textarea
          ref={textareaRef}
          className="chat-input-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onPaste={handlePaste}
          placeholder={placeholder ?? defaultPlaceholder}
          disabled={disabled}
          rows={1}
        />
        <button
          className="chat-input-send"
          onClick={handleSend}
          disabled={disabled || (!text.trim() && images.length === 0)}
          title={`Send (${isMac ? "⌘" : "Ctrl"}+Enter)`}
        >
          <kbd className="chat-input-send-shortcut">{shortcutLabel}</kbd>
        </button>
      </div>
    </div>
  );
}
