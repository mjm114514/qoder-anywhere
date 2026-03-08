import { Router } from "express";
import { scanProjects } from "../services/project-scanner.js";

const router = Router();

// GET /api/projects
router.get("/", async (_req, res, next) => {
  try {
    const projects = await scanProjects();
    res.json(projects);
  } catch (err) {
    next(err);
  }
});

export default router;
