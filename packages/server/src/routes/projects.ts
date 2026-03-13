import { Router } from "express";
import { scanProjects } from "../services/project-scanner.js";
import type { SessionManager } from "../services/session-manager.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";

export function createProjectRoutes(
  sessionManager: SessionManager,
  terminalManager: TerminalManager,
) {
  const router = Router();

  // GET /api/projects
  router.get("/", async (_req, res, next) => {
    try {
      const projects = await scanProjects(sessionManager);

      // Enrich with live active counts from in-memory managers
      const enriched = projects.map((item) => ({
        ...item,
        activeSessionCount: sessionManager.getActiveSessionsByCwd(item.cwd)
          .length,
        activeTerminalCount: terminalManager.list(item.cwd).length,
      }));

      res.json(enriched);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
