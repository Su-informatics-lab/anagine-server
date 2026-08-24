import Rserve from "rserve-client";

const RSERVE_HOST = process.env.RSERVE_HOST || "rserve";
const RSERVE_PORT = Number(process.env.RSERVE_PORT || 6311);

// Generic runner
function runR(script) {
  return new Promise((resolve, reject) => {
    Rserve.connect(RSERVE_HOST, RSERVE_PORT, (err, client) => {
      if (err || !client) return reject(err || new Error("Rserve connect failed"));
      client.evaluate(script, (e, ans) => {
        client.end();
        if (e) return reject(e);
        resolve(ans);
      });
    });
  });
}

// ===== Preset feature 1: linear regression =====
export async function runRserveLm(x, y, addIntercept = true) {
  const xvec = `c(${x.map(v => Number(v) || 0).join(",")})`;
  const yvec = `c(${y.map(v => Number(v) || 0).join(",")})`;
  const formula = addIntercept ? "y ~ x" : "y ~ x - 1";

  const script = `
    x <- ${xvec}
    y <- ${yvec}
    fit <- lm(${formula})
    co <- coef(fit)
    r2 <- summary(fit)$r.squared
    list(coef=unname(co), r2=r2, n=length(y))
  `;
  const ans = await runR(script);
  const coef = Array.isArray(ans?.coef) ? ans.coef : Object.values(ans?.coef || {});
  return { coef, r2: Number(ans?.r2 || 0), n: Number(ans?.n || y.length) };
}

// ===== Preset feature 2: correlation =====
export async function runRserveCorr(x, y) {
  const xvec = `c(${x.map(v => Number(v) || 0).join(",")})`;
  const yvec = `c(${y.map(v => Number(v) || 0).join(",")})`;

  const script = `
    x <- ${xvec}
    y <- ${yvec}
    r <- cor(x, y)
    list(corr=r, n=length(y))
  `;
  const ans = await runR(script);
  return { corr: Number(ans?.corr || 0), n: Number(ans?.n || y.length) };
}
