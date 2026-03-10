import express from "express";
import projectRoutes from "./routes/projects.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { SessionManager } from "./services/session-manager.js";

export function createApp(sessionManager: SessionManager) {
  const app = express();

  app.use(express.json({ limit: "50mb" }));

  // CORS for local development
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Routes
  app.use("/api/projects", projectRoutes);
  app.use("/api/sessions", createSessionRoutes(sessionManager));

  // Error handling middleware
  app.use(
    (
      err: Error & { statusCode?: number; code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("[error]", err);
      const statusCode = err.statusCode ?? 500;
      res.status(statusCode).json({
        error: {
          code: err.code ?? "INTERNAL_ERROR",
          message: err.message,
        },
      });
    },
  );

  return app;
}
