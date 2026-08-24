import express from "express";
import registerQueryFetchRoutes from "./queryFetch.js";
import registerLegacyDataRoutes from "./legacy.js";

export default function createDataRouter(deps) {
  const router = express.Router();
  registerQueryFetchRoutes(router, deps);
  registerLegacyDataRoutes(router, deps);
  return router;
}
