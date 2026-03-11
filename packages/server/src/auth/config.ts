import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Token persistence ──────────────────────────────────────

const TOKEN_DIR = path.join(os.homedir(), ".lgtm-anywhere");
const TOKEN_FILE = path.join(TOKEN_DIR, "auth-token");

/** Generate a 128-bit hex token (32 hex characters). */
function generateToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Read a persisted token from disk. Returns null if not found. */
function readPersistedToken(): string | null {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
    // Validate: must be 32 hex chars
    if (/^[0-9a-f]{32}$/.test(raw)) return raw;
    return null;
  } catch {
    return null;
  }
}

/** Write a token to disk with restricted permissions (owner-only). */
function persistToken(token: string): void {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
}

/**
 * Load or create a persistent auth token.
 * - If a token file exists and is valid, reuse it.
 * - Otherwise generate a new one and persist it.
 */
export function loadOrCreateToken(): string {
  const existing = readPersistedToken();
  if (existing) return existing;

  const token = generateToken();
  persistToken(token);
  return token;
}

/**
 * Refresh the auth token: generate a new one, persist it, and return it.
 */
export function refreshToken(): string {
  const token = generateToken();
  persistToken(token);
  return token;
}

// ─── AuthConfig ─────────────────────────────────────────────

export interface AuthConfig {
  /** Whether auth is enabled */
  enabled: boolean;
  /** 128-bit hex auth token */
  authToken: string;
  /** Secret for signing session cookies */
  sessionSecret: string;
  /** Cookie name */
  cookieName: string;
  /** Cookie max-age in milliseconds */
  cookieMaxAge: number;
  /** Max failed attempts before rate-limiting */
  maxAttempts: number;
  /** Lockout duration in milliseconds after max failed attempts */
  lockoutMs: number;
}

export function loadAuthConfig(
  overrides: { enabled?: boolean; authToken?: string } = {},
): AuthConfig {
  const enabled = overrides.enabled ?? true;
  const authToken = overrides.authToken ?? loadOrCreateToken();

  return {
    enabled,
    authToken,
    sessionSecret: crypto.randomBytes(32).toString("hex"),
    cookieName: "lgtm_session",
    cookieMaxAge: 24 * 60 * 60 * 1000, // 24 hours
    maxAttempts: 5,
    lockoutMs: 60 * 1000, // 1 minute
  };
}
