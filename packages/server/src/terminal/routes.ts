import { Router } from "express";
import type { CreateTerminalRequest } from "@qoder-anywhere/shared";
import { TerminalManager } from "./terminal-manager.js";

export function createTerminalRoutes(manager: TerminalManager): Router {
  const router = Router();

  // POST /api/terminals — create a new terminal
  router.post("/", (req, res, next) => {
    try {
      const body = req.body as CreateTerminalRequest;
      if (!body.cwd) {
        res.status(400).json({
          error: {
            code: "INVALID_REQUEST",
            message: "cwd is required",
          },
        });
        return;
      }

      const id = manager.create(body.cwd);
      res.json({ id });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/terminals — list terminals, optionally filtered by cwd
  router.get("/", (req, res) => {
    const cwd = req.query.cwd as string | undefined;
    res.json(manager.list(cwd));
  });

  // DELETE /api/terminals/:terminal_id — kill and remove a terminal
  router.delete("/:terminal_id", (req, res) => {
    const terminalId = req.params.terminal_id as string;
    const info = manager.get(terminalId);
    if (!info) {
      res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: `Terminal ${terminalId} not found`,
        },
      });
      return;
    }
    manager.kill(terminalId);
    res.json({ id: terminalId, killed: true });
  });

  return router;
}
