import { useState } from "react";
import type { AuthStatus } from "@lgtm-anywhere/shared";
import "./LoginPage.css";

interface LoginPageProps {
  auth: AuthStatus;
  onVerify: (code: string) => Promise<{ ok: boolean; error?: string }>;
}

export function LoginPage({ auth, onVerify }: LoginPageProps) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim() || submitting) return;
    setError("");
    setSubmitting(true);
    const result = await onVerify(token.trim());
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error ?? "Invalid token");
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <svg
            viewBox="0 0 24 24"
            width="48"
            height="48"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
        </div>
        <h1>LGTM Anywhere</h1>
        <p className="login-subtitle">Claude Code in your browser</p>

        {auth.state === "loading" && (
          <p className="login-loading">Checking authentication...</p>
        )}

        {auth.state === "unauthenticated" && (
          <form onSubmit={handleSubmit} className="login-form">
            <p className="login-description">
              Enter the auth token shown in your terminal.
            </p>
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste auth token"
              className="login-input"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
            {error && <p className="login-error-text">{error}</p>}
            <button
              type="submit"
              className="login-btn"
              disabled={!token.trim() || submitting}
            >
              {submitting ? "Verifying..." : "Continue"}
            </button>
          </form>
        )}

        {auth.state === "error" && (
          <div className="login-error">
            <p>{auth.message}</p>
          </div>
        )}
      </div>
    </div>
  );
}
