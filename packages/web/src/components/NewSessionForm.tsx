import { useState, type FormEvent } from "react";
import { createSession } from "../api";
import "./NewSessionForm.css";

interface NewSessionFormProps {
  cwd: string;
  onCreated: (sessionId: string) => void;
}

export function NewSessionForm({ cwd, onCreated }: NewSessionFormProps) {
  const [message, setMessage] = useState("");
  const [model, setModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await createSession(cwd, {
        message: trimmed,
        model: model.trim() || undefined,
      });
      onCreated(res.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
      setSubmitting(false);
    }
  };

  return (
    <div className="new-session-form-wrapper">
      <form className="new-session-form" onSubmit={handleSubmit}>
        <h2 className="new-session-form-title">New Session</h2>
        <p className="new-session-form-cwd">{cwd}</p>

        <label className="new-session-form-label">
          Message
          <textarea
            className="new-session-form-textarea"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What would you like Claude to help with?"
            rows={4}
            disabled={submitting}
          />
        </label>

        <label className="new-session-form-label">
          Model (optional)
          <input
            className="new-session-form-input"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. claude-sonnet-4-6"
            disabled={submitting}
          />
        </label>

        {error && <div className="new-session-form-error">{error}</div>}

        <button
          className="new-session-form-submit"
          type="submit"
          disabled={submitting || !message.trim()}
        >
          {submitting ? "Creating..." : "Create Session"}
        </button>
      </form>
    </div>
  );
}
