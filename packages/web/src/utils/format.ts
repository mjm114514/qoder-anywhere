export function getProjectName(cwd: string): string {
  const segments = cwd.replace(/\/+$/, "").split("/");
  return segments[segments.length - 1] || cwd;
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function extractTextContent(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as Record<string, unknown>;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }
  return "";
}

export function extractToolUse(
  message: unknown
): Array<{ name: string; id: string; input: unknown }> {
  if (!message || typeof message !== "object") return [];
  const msg = message as Record<string, unknown>;
  if (!Array.isArray(msg.content)) return [];
  return (msg.content as Array<Record<string, unknown>>)
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      name: b.name as string,
      id: b.id as string,
      input: b.input,
    }));
}
