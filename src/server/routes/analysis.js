import express from "express";

export default function createAnalysisRouter({
  checkAuth,
  userSessions,
  runRserveLm,
  runRserveCorr,
  runPyKernelLm,
  runPyKernelCorr,
}) {
  const router = express.Router();

  router.post("/analyze", checkAuth, async (req, res) => {
    const username = req.user;
    const session = userSessions[username];
    if (!session?.fetchedData) return res.status(400).json({ error: "No data fetched" });

    const x = session.fetchedData.map((r) => Number(r.age_at_index) || 0);
    const y = session.fetchedData.map((_, i) => i);

    const kernel = session.kernel || "R";
    try {
      if (kernel === "R") {
        return res.json(await runRserveLm(x, y, true));
      }
      if (kernel === "PY") {
        return res.json(await runPyKernelLm(x, y, true));
      }
      return res.status(400).json({ error: "Unknown kernel" });
    } catch (e) {
      return res.status(500).json({ error: String(e) });
    }
  });

  router.post("/corr", checkAuth, async (req, res) => {
    const username = req.user;
    const session = userSessions[username];
    if (!session?.fetchedData) return res.status(400).json({ error: "No data fetched" });

    const x = session.fetchedData.map((r) => Number(r.age_at_index) || 0);
    const y = session.fetchedData.map((_, i) => i);

    const kernel = session.kernel || "R";
    try {
      if (kernel === "R") {
        return res.json(await runRserveCorr(x, y));
      }
      if (kernel === "PY") {
        return res.json(await runPyKernelCorr(x, y));
      }
      return res.status(400).json({ error: "Unknown kernel" });
    } catch (e) {
      return res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
