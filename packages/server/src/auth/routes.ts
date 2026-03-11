import { Router } from "express";
import type {
  AuthStatusResponse,
  AuthMeResponse,
  AuthWsTokenResponse,
} from "@lgtm-anywhere/shared";
import type { AuthConfig } from "./config.js";
import {
  setSessionCookie,
  clearSessionCookie,
  hasValidSession,
} from "./session.js";

// ─── Rate limiting for code verification ─────────────────────

interface RateLimitEntry {
  attempts: number;
  lockedUntil: number;
}

const rateLimits = new Map<string, RateLimitEntry>();

function getRateLimitKey(ip: string): string {
  return ip;
}

function isRateLimited(config: AuthConfig, ip: string): boolean {
  const key = getRateLimitKey(ip);
  const entry = rateLimits.get(key);
  if (!entry) return false;
  if (entry.lockedUntil > Date.now()) return true;
  if (entry.lockedUntil > 0 && entry.lockedUntil <= Date.now()) {
    // Lockout expired — reset
    rateLimits.delete(key);
    return false;
  }
  return false;
}

function recordFailedAttempt(config: AuthConfig, ip: string): void {
  const key = getRateLimitKey(ip);
  const entry = rateLimits.get(key) ?? { attempts: 0, lockedUntil: 0 };
  entry.attempts++;
  if (entry.attempts >= config.maxAttempts) {
    entry.lockedUntil = Date.now() + config.lockoutMs;
  }
  rateLimits.set(key, entry);
}

function clearRateLimit(ip: string): void {
  rateLimits.delete(getRateLimitKey(ip));
}

// ─── Token store for WS auth ─────────────────────────────────
// Short-lived tokens that authenticated clients can use for WS

import crypto from "node:crypto";

const wsTokens = new Map<string, { expiresAt: number }>();
const WS_TOKEN_TTL = 30_000; // 30 seconds

function issueWsToken(): string {
  const token = crypto.randomBytes(24).toString("hex");
  wsTokens.set(token, { expiresAt: Date.now() + WS_TOKEN_TTL });
  return token;
}

export function isValidWsToken(token: string): boolean {
  const entry = wsTokens.get(token);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    wsTokens.delete(token);
    return false;
  }
  // One-time use
  wsTokens.delete(token);
  return true;
}

// Clean up expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of wsTokens) {
    if (val.expiresAt < now) wsTokens.delete(key);
  }
}, 60 * 1000).unref();

// ─── Router ──────────────────────────────────────────────────

export function createAuthRouter(config: AuthConfig): Router {
  const router = Router();

  // ─── GET /api/auth/status ──────────────────────────────
  router.get("/status", (_req, res) => {
    res.json({
      authEnabled: config.enabled,
    } satisfies AuthStatusResponse);
  });

  // ─── GET /api/auth/me ──────────────────────────────────
  router.get("/me", (req, res) => {
    if (!config.enabled) {
      res.json({ authenticated: true } satisfies AuthMeResponse);
      return;
    }
    const valid = hasValidSession(req, config);
    if (!valid) {
      res.status(401).json({
        authenticated: false,
      } satisfies AuthMeResponse);
      return;
    }
    res.json({ authenticated: true } satisfies AuthMeResponse);
  });

  // ─── POST /api/auth/verify ────────────────────────────
  router.post("/verify", (req, res) => {
    if (!config.enabled) {
      res.json({ ok: true });
      return;
    }

    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";

    if (isRateLimited(config, ip)) {
      res.status(429).json({
        ok: false,
        error: "Too many attempts. Please wait a minute.",
      });
      return;
    }

    const { token } = req.body as { token?: string };
    if (!token) {
      res.status(400).json({
        ok: false,
        error: "Auth token is required",
      });
      return;
    }

    // Exact comparison
    if (token.trim() !== config.authToken) {
      recordFailedAttempt(config, ip);
      res.status(401).json({
        ok: false,
        error: "Invalid auth token",
      });
      return;
    }

    // Success — set session cookie and clear rate limit
    clearRateLimit(ip);
    setSessionCookie(res, config);
    res.json({ ok: true });
  });

  // ─── POST /api/auth/logout ─────────────────────────────
  router.post("/logout", (_req, res) => {
    clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  // ─── GET /api/auth/ws-token ────────────────────────────
  router.get("/ws-token", (req, res) => {
    if (!config.enabled) {
      res.json({ token: "" } satisfies AuthWsTokenResponse);
      return;
    }
    if (!hasValidSession(req, config)) {
      res.status(401).json({
        error: "unauthenticated",
        message: "Login required",
      });
      return;
    }
    const token = issueWsToken();
    res.json({ token } satisfies AuthWsTokenResponse);
  });

  return router;
}
