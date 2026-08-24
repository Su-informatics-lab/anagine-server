import { spawn } from "child_process";
import fetch from "node-fetch";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { chatWithModel, generateText } from "../../utils/llm.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const toBool = (v) => {
  if (typeof v === "boolean") return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "on" || s === "yes";
};

const getBaseUrl = (req) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
};

function toNumberIfNumeric(v) {
  if (v === null || v === undefined) return v;
  const n = Number(v);
  return Number.isFinite(n) && String(n) === String(v) ? n : v;
}

function buildFiltersFromQuery(q) {
  if (q.filters) {
    try {
      return JSON.parse(q.filters);
    } catch {
      // ignore malformed JSON and continue with key-style filters
    }
  }

  const AND = [];
  for (const [k, raw] of Object.entries(q)) {
    if (k.startsWith("eq_")) {
      const f = k.slice(3);
      AND.push({ "=": { [f]: toNumberIfNumeric(raw) } });
    }
    if (k.startsWith("in_")) {
      const f = k.slice(3);
      const arr = String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(toNumberIfNumeric);
      AND.push({ in: { [f]: arr } });
    }
    if (k.startsWith("gte_")) {
      const f = k.slice(4);
      AND.push({ ">=": { [f]: toNumberIfNumeric(raw) } });
    }
    if (k.startsWith("lte_")) {
      const f = k.slice(4);
      AND.push({ "<=": { [f]: toNumberIfNumeric(raw) } });
    }
  }

  return AND.length ? { AND } : undefined;
}

function extractRowsFromAny(json, indexGuess) {
  if (Array.isArray(json)) return json;

  const idx = indexGuess && json?.data?.[indexGuess];
  if (Array.isArray(idx)) return idx;

  if (idx?.hits?.edges) return idx.hits.edges.map((e) => e.node);

  const roots = json?.data && Object.keys(json.data);
  if (roots && roots.length) {
    const r = json.data[roots[0]];
    if (Array.isArray(r)) return r;
    if (r?.hits?.edges) return r.hits.edges.map((e) => e.node);
  }

  throw new Error("Cannot extract rows: expected array or GraphQL hits.edges format");
}

async function fetchRowsFromSource(req, { config, log }) {
  const q = req.query;
  const limit = Number(q.limit || 200);
  const offset = Number(q.offset || 0);
  const index = q.index || "case";

  if (q.url) {
    const r = await fetch(q.url);
    if (!r.ok) throw new Error(`fetch url failed: ${r.status}`);
    const json = await r.json();
    const rows = extractRowsFromAny(json, index);
    return rows.slice(0, limit);
  }

  const base = (config?.guppyConfig?.host || "http://localhost:3010").replace(/\/+$/, "");

  const fields = (q.fields ? String(q.fields).split(",").map((s) => s.trim()).filter(Boolean) : [])
    .concat([q.x_field, q.y_field].filter(Boolean))
    .filter((v, i, a) => v && a.indexOf(v) === i);
  if (!fields.length) throw new Error("no fields provided (use ?fields=a,b or ?x_field=&y_field=)");

  const filters = buildFiltersFromQuery(q);

  const gql = `
    query($first:Int, $offset:Int){
      ${index}(first:$first, offset:$offset) {
        ${fields.join("\n        ")}
      }
    }`;

  const token = req.headers.authorization?.split(" ")[1];

  log.info(`[fetchRowsFromSource] Querying ${base}/graphql with token: ${token ? "present" : "missing"}`);
  log.info(`[fetchRowsFromSource] Index: ${index}, Fields: ${fields.join(", ")}`);
  log.info(`[fetchRowsFromSource] GraphQL Query:\n${gql}`);

  const resp = await fetch(`${base}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query: gql, variables: { first: limit, offset, filters } }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    log.error(`[fetchRowsFromSource] Guppy error (${resp.status}):`, errorText);
    throw new Error(`guppy graphql failed: ${resp.status} - ${errorText}`);
  }

  const json = await resp.json();
  return extractRowsFromAny(json, index);
}

export default function registerLegacyDataRoutes(router, { config, log }) {
  router.get("/hello", (req, res) => {
    res.send({
      text: "Hello World",
      time: new Date().toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: "UTC",
      }),
      subject: [
        { patient: "Patient A", age: 30, hospital: { name: "General Hospital", location: "Indiana" } },
        { patient: "Patient B", age: 65, hospital: { name: "Another Hospital", location: "New York" } },
      ],
    });
  });

  router.get("/pdf", (req, res) => {
    const filepath = "/home/exouser/Downloads/gen3.pdf";
    res.download(filepath);
  });

  router.post("/R/lm", (req, res) => {
    const data = req.body || { x: [1, 2, 3], y: [3, 5, 7] };
    const inputJSON = JSON.stringify(data);
    const rScriptPath = process.env.RSCRIPT_PATH || path.join(__dirname, "../../../R/lm.R");
    log.info("rScriptPath:", rScriptPath);

    const rProcess = spawn("Rscript", [rScriptPath]);
    rProcess.stdin.write(inputJSON);
    rProcess.stdin.end();

    let output = "";
    let errorOutput = "";

    rProcess.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    rProcess.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });

    rProcess.on("close", (code) => {
      if (code !== 0) {
        return res.status(500).send(`Error running R script: ${errorOutput}`);
      }
      try {
        const result = JSON.parse(output);
        result.time = new Date().toLocaleString("en-US", {
          dateStyle: "full",
          timeStyle: "long",
          timeZone: "UTC",
        });
        res.json(result);
      } catch {
        res.status(500).send("Error parsing R script output.");
      }
    });
  });

  router.get("/llm/chat", async (req, res) => {
    const { model = config.defaultLlmModel, prompt, stream, ...options } = req.query;
    const streamFlag = toBool(stream);
    const messages = [{ role: "user", content: prompt || "Hi, could you introduce yourself?" }];
    try {
      const llmResponse = await chatWithModel(model, messages, streamFlag, options);
      res.send({ response: llmResponse });
    } catch (err) {
      res.status(500).send({ error: err.message });
    }
  });

  router.get("/llm/generate", async (req, res) => {
    const { model = config.defaultLlmModel, prompt = "", stream, ...options } = req.query;
    const streamFlag = toBool(stream);
    try {
      if (streamFlag) {
        let full = "";
        const iter = await generateText(model, prompt, true, options);
        for await (const part of iter) {
          if (part?.response) full += part.response;
        }
        res.json({ response: full });
      } else {
        const llmResponse = await generateText(model, prompt, false, options);
        res.json(llmResponse);
      }
    } catch (err) {
      res.status(500).send({ error: err.message });
    }
  });

  router.get("/data/apply", async (req, res) => {
    try {
      const action = (req.query.action || "").toLowerCase();
      if (!["regression", "llm"].includes(action)) {
        return res.status(400).json({ error: "action must be 'regression' or 'llm'" });
      }

      const rows = await fetchRowsFromSource(req, { config, log });
      const limit = Number(req.query.limit || 200);

      if (action === "regression") {
        const xField = req.query.x_field;
        const yField = req.query.y_field;
        if (!xField || !yField) {
          return res.status(400).json({ error: "x_field & y_field are required for regression" });
        }

        const x = [];
        const y = [];
        for (const r of rows) {
          const xv = Number(r?.[xField]);
          const yv = Number(r?.[yField]);
          if (Number.isFinite(xv) && Number.isFinite(yv)) {
            x.push(xv);
            y.push(yv);
          }
        }
        if (x.length < 2) return res.status(400).json({ error: "not enough numeric pairs" });

        const host = getBaseUrl(req);
        const lm = await fetch(`${host}/anagine/R/lm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ x, y }),
        }).then((r) => r.json());

        return res.json({
          action,
          n: x.length,
          limit,
          x_field: xField,
          y_field: yField,
          stats: lm,
        });
      }

      const model = req.query.model || (config?.defaultLlmModel || "llama3.2:1b");
      const fields = (req.query.fields || "").split(",").map((s) => s.trim()).filter(Boolean);
      const preview = rows.slice(0, Math.min(10, rows.length));
      const prompt = `
You are analyzing a small dataset preview.
fields: ${fields.length ? fields.join(",") : "(unspecified)"}
count: ${rows.length}

Preview (JSON, first ${preview.length} rows):
${JSON.stringify(preview, null, 2)}

Summarize patterns and potential relationships in plain English.
Avoid statistical claims. Keep it under 120 words.`;

      try {
        const g = await generateText(model, prompt, false, {});

        return res.json({
          action,
          model,
          total_rows: rows.length,
          limit,
          preview_rows: preview.length,
          analysis: g.response || g,
        });
      } catch (llmError) {
        log.error("[data/apply] LLM error:", llmError);
        return res.json({
          action,
          model,
          total_rows: rows.length,
          limit,
          preview_rows: preview.length,
          analysis: { error: llmError.message },
        });
      }
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });
}
