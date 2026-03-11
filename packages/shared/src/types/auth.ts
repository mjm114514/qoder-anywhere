// ─── API types ────────────────────────────────────────────────

/** GET /api/auth/status → 200 */
export interface AuthStatusResponse {
  authEnabled: boolean;
}

/** POST /api/auth/verify — request body */
export interface AuthVerifyRequest {
  token: string;
}

/** POST /api/auth/verify → 200 (success) */
export interface AuthVerifyResponse {
  ok: true;
}

/** POST /api/auth/verify → 401 (wrong code) */
export interface AuthVerifyError {
  ok: false;
  error: string;
}

/** GET /api/auth/me → 200 */
export interface AuthMeResponse {
  authenticated: boolean;
}

/** GET /api/auth/ws-token → 200 */
export interface AuthWsTokenResponse {
  token: string;
}

// ─── Auth status for frontend state ───────────────────────────

export type AuthStatus =
  | { state: "loading" }
  | { state: "authenticated" }
  | { state: "unauthenticated" }
  | { state: "error"; message: string }
  | { state: "disabled" };
