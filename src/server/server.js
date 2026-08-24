import express from "express";
import cors from "cors";
import helmet from "helmet";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import config from "./config.js";
import log from "./logger.js";
import graphQLProxy from "./graphql.js";
import { statusProxy, versionProxy } from "./endpoints.js";
import CodedError from "./utils/error.js";

import arboristProxy from "./routes/arboristProxy.js";
import createReportRouter from "./routes/report.js";
import createAuthRouter, { createCheckAuthMiddleware } from "./routes/auth.js";
import createDataRouter from "./routes/data.js";
import createAnalysisRouter from "./routes/analysis.js";
import createLlmRouter from "./routes/llm.js";

import { runRserveLm, runRserveCorr } from "../R/rserveFunctions.js";
import { runPyKernelLm, runPyKernelCorr } from "../pykernel/pykernelFunctions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const datasetsPath = path.join(__dirname, "../../data/datasets.json");

const datasets = JSON.parse(fs.readFileSync(datasetsPath));
const userSessions = {};

const OPENAI_BASE_URL =
  process.env.ANAGINE_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || process.env.MSU_API_URL || "";
const OPENAI_MODEL =
  process.env.ANAGINE_OPENAI_MODEL || process.env.OPENAI_MODEL || process.env.MSU_MODEL || "gpt-oss20b";
const OLLAMA_HOST = process.env.ANAGINE_OLLAMA_HOST || process.env.OLLAMA_HOST || "http://ollama:11434";
const OLLAMA_MODEL = process.env.ANAGINE_OLLAMA_MODEL || process.env.OLLAMA_MODEL || "llama3.2:1b";

function compactSerialize(value, maxLen = 600) {
  if (value == null || value === "") return "";
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function deriveRequestFilters(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const query = req.query && typeof req.query === "object" ? req.query : {};

  if ("filters" in body && body.filters != null) return compactSerialize(body.filters);
  if ("caseFilter" in body && body.caseFilter != null) return compactSerialize(body.caseFilter);
  if ("followUpTimeRange" in body && body.followUpTimeRange != null) {
    return compactSerialize({ followUpTimeRange: body.followUpTimeRange });
  }
  if ("filters" in query && query.filters != null) return compactSerialize(query.filters);
  return "";
}

function serviceEnvironment() {
  return (
    process.env.ANAGINE_ENV ||
    process.env.GEN3_NAMESPACE ||
    process.env.KUBE_NAMESPACE ||
    process.env.NAMESPACE ||
    process.env.NODE_ENV ||
    "unknown"
  );
}

function writeStructuredEvent(category, payload, level = "INFO") {
  const timestamp = new Date().toISOString();
  log.rawOutput(level, `[${timestamp}] ${category}: ${JSON.stringify({
    "@timestamp": timestamp,
    service: "anagine",
    environment: serviceEnvironment(),
    ...payload,
  })}`);
}

function requestPath(req) {
  return String(req.originalUrl || req.url || "").split("?")[0];
}

function isReportDownloadRequest(req) {
  return ["GET", "HEAD"].includes(req.method) && /^\/(?:anagine\/)?reports\/.+\.(?:pdf|html)$/i.test(requestPath(req));
}

function isReportGenerationRequest(req) {
  return req.method === "POST" && /^\/(?:anagine\/)?report(?:\/(?:participants|follow-ups|biospecimens|lab-results))?\/?$/i.test(requestPath(req));
}

function isLoginRequest(req) {
  return req.method === "POST" && /^\/(?:anagine\/)?login\/?$/i.test(requestPath(req));
}

function shouldSkipHttpAccessLog(req) {
  return isReportDownloadRequest(req) || isReportGenerationRequest(req) || isLoginRequest(req);
}

function logReportDownload(req, res, next) {
  const start = Date.now();
  const fileName = path.basename(String(req.path || req.url || "").split("?")[0]);
  const ext = path.extname(fileName).toLowerCase();
  const shouldLog = isReportDownloadRequest(req);

  if (shouldLog) {
    res.on("finish", () => {
      const status = res.statusCode;
      const outcome = status >= 200 && status < 400 ? "success" : "failure";
      writeStructuredEvent("DOWNLOAD", {
        event_type: "report_download",
        outcome,
        user: req.user || "anonymous",
        method: req.method,
        url: req.originalUrl || req.url,
        status,
        file_name: fileName || null,
        file_extension: ext || null,
        duration_ms: Date.now() - start,
        vis_event_type: "report_download",
        vis_outcome: outcome,
      });
    });
  }

  next();
}

const app = express();
app.use(cors());
app.use(helmet());
app.use(bodyParser.json());
app.use(cookieParser());

app.use((req, res, next) => {
  log.withRequestContext(
    {
      method: req.method,
      url: req.originalUrl || req.url,
      filters: deriveRequestFilters(req),
    },
    () => {
      const start = Date.now();
      const skipHttpAccessLog = shouldSkipHttpAccessLog(req);
      if (!skipHttpAccessLog) {
        log.info(`[HTTP] ${req.method} ${req.url}`);
      }

      res.on("finish", () => {
        const duration = Date.now() - start;
        if (typeof log.updateRequestContext === "function") {
          log.updateRequestContext({
            method: req.method,
            url: req.originalUrl || req.url,
            filters: deriveRequestFilters(req),
            username: req.user || undefined,
          });
        }
        if (!skipHttpAccessLog) {
          log.info(`[HTTP] ${req.method} ${req.url} -> ${res.statusCode} (${duration}ms)`);
        }
      });

      next();
    }
  );
});

app.use((req, res, next) => {
  if (typeof log.updateRequestContext === "function") {
    log.updateRequestContext({
      method: req.method,
      url: req.originalUrl || req.url,
      filters: deriveRequestFilters(req),
      username: req.user || undefined,
    });
  }
  next();
});

const checkAuth = createCheckAuthMiddleware({ log });

const reportsDir = process.env.REPORTS_DIR || path.join(__dirname, "../../reports");

/**
 * Build a sub-router containing all anagine-specific routes (no path prefix).
 *
 * Mounting this router at both "/anagine" and "/" allows the service to work
 * whether the upstream proxy preserves the "/anagine" prefix or strips it.
 */
function buildAnagineRouter() {
  const router = express.Router();

  router.use(arboristProxy);
  router.use("/reports", logReportDownload);
  router.use("/reports", express.static(reportsDir));
  router.use(createAuthRouter({ userSessions, log }));
  router.use(createDataRouter({ checkAuth, userSessions, datasets, log, config }));
  router.use(
    createAnalysisRouter({
      checkAuth,
      userSessions,
      runRserveLm,
      runRserveCorr,
      runPyKernelLm,
      runPyKernelCorr,
    }),
  );
  router.use(createLlmRouter({ checkAuth, userSessions, log }));
  router.use(createReportRouter({ checkAuth, userSessions }));

  router.get("/status", checkAuth, (req, res) => {
    const username = req.user;
    const s = userSessions[username] || {};
    res.json({
      dataset: s.dataset ?? null,
      filters: s.filters ?? null,
      kernel: s.kernel ?? "R",
      fetchedCount: Array.isArray(s.fetchedData) ? s.fetchedData.length : 0,
      llmHistoryCount: Array.isArray(s.llmHistory) ? s.llmHistory.length : 0,
      lastLLMMessage:
        Array.isArray(s.llmHistory) && s.llmHistory.length > 0
          ? s.llmHistory[s.llmHistory.length - 1]
          : null,
    });
  });

  router.get("/", (req, res) => {
    res.send("<h2>Anagine API</h2><p>Use /login, /status, /fetch, etc.</p>");
  });

  router.use((err, req, res, next) => {
    void next;
    if (err instanceof CodedError) res.status(err.code).send(err.msg);
    else res.status(500).send(err);
  });

  return router;
}

// Primary mount: proxy preserves the /anagine prefix.
app.use("/anagine", buildAnagineRouter());

// Shared service routes must be registered before the fallback mount.
app.use("/graphql", graphQLProxy);
app.use("/_status", statusProxy);
app.use("/_version", versionProxy);

// Fallback mount: proxy strips the /anagine prefix before forwarding.
app.use("/", buildAnagineRouter());


app.listen(config.port, () => {
  log.info(`[Server] anagine listening on port ${config.port}!`);
  log.info(
    `[LLM] primary: ${OPENAI_BASE_URL ? `${OPENAI_MODEL} @ ${OPENAI_BASE_URL}` : "none"}, backup: Ollama ${OLLAMA_MODEL} @ ${OLLAMA_HOST}`
  );
});
