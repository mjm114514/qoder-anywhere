import crypto from "node:crypto";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthConfig } from "./config.js";

/**
 * Cookie value is a signed token: random-hex + "." + hmac-sha256.
 * The token proves the user supplied a valid auth token.
 */

/** Generate a signed session token. */
function signToken(secret: string): string {
  const payload = crypto.randomBytes(16).toString("hex");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/** Verify a signed session token. */
function verifyToken(token: string, secret: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  if (!payload || !sig) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/** Set a session cookie on the response. */
export function setSessionCookie(
  res: ServerResponse,
  config: AuthConfig,
): void {
  const token = signToken(config.sessionSecret);
  const cookie = serializeCookie(config.cookieName, token, {
    httpOnly: true,
    secure: false, // lgtm-anywhere may run over plain HTTP
    sameSite: "lax",
    path: "/",
    maxAge: config.cookieMaxAge / 1000,
  });
  res.setHeader("Set-Cookie", cookie);
}

/** Clear the session cookie. */
export function clearSessionCookie(
  res: ServerResponse,
  config: AuthConfig,
): void {
  const cookie = serializeCookie(config.cookieName, "", {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  res.setHeader("Set-Cookie", cookie);
}

/** Check if the request has a valid session cookie. */
export function hasValidSession(
  req: IncomingMessage,
  config: AuthConfig,
): boolean {
  const cookies = parseCookie(req.headers.cookie ?? "");
  const token = cookies[config.cookieName];
  if (!token) return false;
  return verifyToken(token, config.sessionSecret);
}
