// ~/Desktop/anagine/src/pykernel/pykernelFunctions.js
import fetch from "node-fetch";

const PYKERNEL_URL = process.env.PYKERNEL_URL || "http://py-kernel:8000";

// ===== Linear Regression (lm) =====
export async function runPyKernelLm(x, y, addIntercept = true) {
  const r = await fetch(`${PYKERNEL_URL}/lm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x, y, add_intercept: addIntercept }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`py-kernel error ${r.status}: ${t}`);
  }
  return await r.json();
}

// ===== Correlation (corr) =====
export async function runPyKernelCorr(x, y) {
  const r = await fetch(`${PYKERNEL_URL}/corr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x, y }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`py-kernel error ${r.status}: ${t}`);
  }
  return await r.json();
}
