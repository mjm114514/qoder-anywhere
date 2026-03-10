import { Router } from "express";
import {
  listSessions,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  CreateSessionRequest,
  UpdateSessionRequest,
  PermissionMode,
} from "@lgtm-anywhere/shared";
import { SessionManager } from "../services/session-manager.js";

export function createSessionRoutes(sessionManager: SessionManager): Router {
  const router = Router();

  // GET /api/sessions?cwd=...
  router.get("/", async (req, res, next) => {
    try {
      const cwd = req.query.cwd as string | undefined;
      if (!cwd) {
        res.status(400).json({
          error: {
            code: "INVALID_REQUEST",
            message: "cwd query parameter is required",
          },
        });
        return;
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const sessions = await listSessions({ dir: cwd, limit });

      const diskIds = new Set(sessions.map((s) => s.sessionId));

      const result = sessions.map((s) => ({
        sessionId: s.sessionId,
        summary: s.summary,
        lastModified: s.lastModified,
        fileSize: s.fileSize,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        state: sessionManager.getState(s.sessionId),
      }));

      // Merge in-memory sessions that haven't been persisted to disk yet
      for (const active of sessionManager.getActiveSessionsByCwd(cwd)) {
        if (!diskIds.has(active.sessionId)) {
          result.unshift({
            sessionId: active.sessionId,
            summary: "",
            lastModified: active.createdAt,
            fileSize: 0,
            cwd: active.cwd,
            gitBranch: undefined,
            state: active.state,
          });
        }
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:session_id
  router.get("/:session_id", async (req, res, next) => {
    try {
      const sessionId = req.params.session_id as string;
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;

      const messages = await getSessionMessages(sessionId, { limit, offset });

      // Get summary from listSessions (no dir — searches all)
      const allSessions = await listSessions({});
      const sessionInfo = allSessions.find((s) => s.sessionId === sessionId);

      res.json({
        sessionId,
        summary: sessionInfo?.summary ?? "",
        lastModified: sessionInfo?.lastModified ?? 0,
        state: sessionManager.getState(sessionId),
        messages: messages.map((m) => ({
          type: m.type,
          uuid: m.uuid,
          message: m.message,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/sessions?cwd=...
  router.post("/", async (req, res, next) => {
    try {
      const cwd = req.query.cwd as string | undefined;
      if (!cwd) {
        res.status(400).json({
          error: {
            code: "INVALID_REQUEST",
            message: "cwd query parameter is required",
          },
        });
        return;
      }

      const body = req.body as CreateSessionRequest;
      if (!body.message) {
        res.status(400).json({
          error: { code: "INVALID_REQUEST", message: "message is required" },
        });
        return;
      }

      const session = await sessionManager.createSession(cwd, {
        message: body.message,
        model: body.model,
        permissionMode: body.permissionMode,
        allowedTools: body.allowedTools,
        systemPrompt: body.systemPrompt,
        maxTurns: body.maxTurns,
        images: body.images,
      });

      // Wait for SDK init message to provide the sessionId
      const sessionId = await session.sessionIdReady;

      res.json({ sessionId });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/sessions/:session_id
  router.put("/:session_id", async (req, res, next) => {
    try {
      const sessionId = req.params.session_id as string;
      const body = req.body as UpdateSessionRequest;

      if (body.model) {
        await sessionManager.setModel(sessionId, body.model);
      }

      if (body.permissionMode) {
        const validModes: PermissionMode[] = [
          "default",
          "acceptEdits",
          "bypassPermissions",
          "plan",
          "dontAsk",
        ];
        if (!validModes.includes(body.permissionMode as PermissionMode)) {
          res.status(400).json({
            error: {
              code: "INVALID_REQUEST",
              message: `Invalid permission mode: ${body.permissionMode}`,
            },
          });
          return;
        }
        await sessionManager.setPermissionMode(
          sessionId,
          body.permissionMode as PermissionMode,
        );
      }

      res.json({
        sessionId,
        title: body.title,
        model: body.model,
        permissionMode: body.permissionMode,
      });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/sessions/:session_id
  router.delete("/:session_id", async (req, res, next) => {
    try {
      const sessionId = req.params.session_id as string;

      await sessionManager.stopSession(sessionId);

      res.json({
        sessionId,
        stopped: true,
        fileDeleted: false,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
