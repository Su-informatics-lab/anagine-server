// report.js - from upstream, integrated with existing auth
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { buildReportMeta } from "./reportBuilders.js";
import config from "../config.js";
import log from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATES_DIR = process.env.TEMPLATES_DIR || path.join(__dirname, "../../../templates");
const REPORTS_DIR = process.env.REPORTS_DIR || path.join(__dirname, "../../../reports");
const RENDER_RUNTIME_DIR =
  process.env.REPORT_RENDER_DIR || path.join(path.dirname(REPORTS_DIR), "anagine-render");
const REPORT_RETENTION_MS = parseMs(process.env.REPORT_RETENTION_MS, 24 * 60 * 60 * 1000);
const RENDER_RETENTION_MS = parseMs(process.env.RENDER_RETENTION_MS, 60 * 60 * 1000);
const REPORT_CLEANUP_INTERVAL_MS = parseMs(process.env.REPORT_CLEANUP_INTERVAL_MS, 60 * 60 * 1000);
const REPORT_ASSET_FILES = new Set(["AlcHepNet_logo.jpg"]);
const FILTER_RAW_MAX_LEN = parseMs(process.env.REPORT_USAGE_FILTER_MAX_LEN, 12000);
const FILTER_PAIR_MAX_LEN = 300;

let reportCleanupLoopStarted = false;

function parseMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function createReportTiming() {
  const timings = [];
  const startedAt = Date.now();
  return {
    timings,
    startedAt,
    mark(label, startMs, extra = {}) {
      timings.push({
        label,
        ms: Date.now() - startMs,
        ...extra,
      });
    },
  };
}

function logReportTiming({ requestId, status, template, reportView, outFile, format, startedAt, timings }) {
  const timestamp = new Date().toISOString();
  log.rawOutput(
    "DEBUG",
    `[${timestamp}] DEBUG: ${JSON.stringify({
      "@timestamp": timestamp,
      event_type: "report_timing_debug",
      request_id: requestId,
      status,
      report_template: template,
      report_view: reportView,
      out_file: outFile,
      format,
      duration_total_ms: Date.now() - startedAt,
      details: timings,
    })}`
  );
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

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function compactJsonString(value, maxLen = FILTER_RAW_MAX_LEN) {
  const text = safeJsonStringify(value ?? {});
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function toMs(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sumTimings(timings, predicate) {
  return (Array.isArray(timings) ? timings : []).reduce((total, item) => {
    return predicate(item) ? total + toMs(item?.ms) : total;
  }, 0);
}

function summarizeReportDurations({ timings, totalMs }) {
  const guppyFetchMs = sumTimings(timings, (item) => {
    const label = String(item?.label || "");
    return (
      label === "buildMeta.fetch.queryParams" ||
      label === "buildMeta.fetch.baseline.source" ||
      /^buildMeta\.fetch\.baseline\..*\.total$/.test(label)
    );
  });
  const renderPdflatexMs = sumTimings(timings, (item) => item?.label === "report.render.pdflatex");
  const renderRscriptMs = sumTimings(timings, (item) => item?.label === "report.render.rscript");

  return {
    duration_total_ms: toMs(totalMs),
    duration_setup_ms: sumTimings(timings, (item) => item?.label === "report.setup"),
    duration_build_meta_ms: sumTimings(timings, (item) => item?.label === "report.buildMeta.total"),
    duration_guppy_resolve_ms: sumTimings(timings, (item) => item?.label === "buildMeta.resolveGuppyUrl"),
    duration_guppy_fetch_ms: guppyFetchMs,
    duration_transform_ms: sumTimings(timings, (item) => String(item?.label || "").startsWith("buildMeta.transform.")),
    duration_render_prepare_ms: sumTimings(timings, (item) => item?.label === "report.render.prepare"),
    duration_render_ms: renderRscriptMs + renderPdflatexMs,
    duration_cleanup_ms: sumTimings(timings, (item) => item?.label === "report.cleanup"),
  };
}

function hasFilterValue(value) {
  if (value == null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function filterValueParts(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && Array.isArray(value.selectedValues)) return value.selectedValues;
  return [value];
}

function compactFilterPairValue(value) {
  const text = typeof value === "string" ? value : safeJsonStringify(value);
  return text.length > FILTER_PAIR_MAX_LEN ? `${text.slice(0, FILTER_PAIR_MAX_LEN)}...` : text;
}

function summarizeFilterUsage(filters) {
  const filterValue = hasFilterValue(filters) ? filters : {};
  const filterKeys = filterValue && typeof filterValue === "object" && !Array.isArray(filterValue)
    ? Object.keys(filterValue)
    : [];
  const filterPairs = [];

  for (const key of filterKeys) {
    for (const value of filterValueParts(filterValue[key])) {
      filterPairs.push(`${key}=${compactFilterPairValue(value)}`);
    }
  }

  return {
    filters_raw_json: compactJsonString(filterValue),
    filter_keys: filterKeys,
    filter_pairs: filterPairs,
  };
}

function reportErrorType(status, payload, fallback = null) {
  if (Number(status) < 400) return null;
  const message = String(payload?.error || fallback || "");
  if (/Rmarkdown finished but output file missing/i.test(message)) return "render_output_missing";
  if (/Rmarkdown render failed/i.test(message)) return "rmarkdown_render_failed";
  if (/pdflatex compile failed/i.test(message)) return "pdflatex_compile_failed";
  if (/Template not found/i.test(message)) return "template_not_found";
  if (/format must be/i.test(message)) return "invalid_format";
  if (/No user on req\.user/i.test(message)) return "missing_user";
  return "report_error";
}

function logReportUsageStart({
  req,
  requestId,
  username,
  template,
  reportView,
  sourceIndex,
  format,
  filters,
}) {
  const reportName = reportView || "generic";
  const timestamp = new Date().toISOString();
  const filterSummary = summarizeFilterUsage(filters);
  const payload = {
    "@timestamp": timestamp,
    event_type: "report_request",
    outcome: "started",
    service: "anagine",
    environment: serviceEnvironment(),
    request_id: requestId,
    user: username || "anonymous",
    method: req?.method || null,
    url: req?.originalUrl || req?.url || null,
    report_template: template || null,
    report_view: reportName,
    source_index: sourceIndex || null,
    format: format || null,
    filter_keys: filterSummary.filter_keys,
    filter_pairs: filterSummary.filter_pairs,
    vis_event_type: "report_request",
    vis_report_name: reportName,
    vis_outcome: "started",
  };

  log.rawOutput("INFO", `[${timestamp}] USAGE_LOG: ${JSON.stringify(payload)}`);
}

function logReportRuntime({
  req,
  requestId,
  username,
  status,
  template,
  reportView,
  sourceIndex,
  outFile,
  format,
  fetchedCount,
  filters,
  startedAt,
  timings,
  errorType = null,
  errorMessage = null,
}) {
  const numericStatus = Number(status);
  const outcome = numericStatus >= 200 && numericStatus < 400 ? "success" : "failure";
  const reportName = reportView || "generic";
  const totalMs = Date.now() - startedAt;

  const timestamp = new Date().toISOString();
  const payload = {
    "@timestamp": timestamp,
    event_type: "report_generation",
    outcome,
    service: "anagine",
    environment: serviceEnvironment(),
    request_id: requestId,
    user: username || "anonymous",
    method: req?.method || null,
    url: req?.originalUrl || req?.url || null,
    status: Number.isFinite(numericStatus) ? numericStatus : status,
    report_template: template || null,
    report_view: reportName,
    source_index: sourceIndex || null,
    format: format || null,
    out_file: outFile || null,
    fetched_count: fetchedCount ?? null,
    ...summarizeFilterUsage(filters),
    ...summarizeReportDurations({ timings, totalMs }),
    error_type: errorType,
    error_message: errorMessage,
    vis_event_type: "report_generation",
    vis_report_name: reportName,
    vis_outcome: outcome,
  };

  log.rawOutput("INFO", `[${timestamp}] RUNTIME_LOG: ${JSON.stringify(payload)}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function resolveTemplatePath(template) {
  const candidates = [];
  if (String(template || "").toLowerCase().endsWith(".rmd")) {
    candidates.push(path.join(TEMPLATES_DIR, template));
  } else {
    candidates.push(path.join(TEMPLATES_DIR, `${template}.rmd`));
    candidates.push(path.join(TEMPLATES_DIR, `${template}.Rmd`));
    candidates.push(path.join(TEMPLATES_DIR, template));
  }
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function syncTemplateAssetsToReportsDir() {
  const assetNames = ["AlcHepNet_logo.jpg"];
  for (const assetName of assetNames) {
    const src = path.join(TEMPLATES_DIR, assetName);
    const dest = path.join(REPORTS_DIR, assetName);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

function safeName(s) {
  return String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function renderOutputOptions(template, fmt) {
  const base = path.basename(String(template || "")).toLowerCase().replace(/\.rmd$/i, "");
  // demo_age_meld_report requires a visible TOC in both html and pdf.
  if (base !== "demo_age_meld_report") return "";

  if (fmt === "html") {
    return "  output_options = list(toc = TRUE, toc_depth = 2),\n";
  }
  if (fmt === "pdf") {
    // Keep PDF TOC placement controlled by template chunks (cover -> contents -> tables/figures).
    return "  output_options = list(toc = FALSE),\n";
  }
  return "";
}

function runPdflatexCompile(texFileName, cwd, passes = 2) {
  return new Promise((resolve) => {
    const runOnce = () =>
      new Promise((res) => {
        const child = spawn("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", texFileName], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        let settled = false;
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          res({ code: 1, stdout, stderr: `${stderr}\n${error?.message || error}`.trim() });
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          res({ code, stdout, stderr });
        });
      });

    (async () => {
      const runs = [];
      for (let i = 0; i < passes; i += 1) {
        const result = await runOnce();
        runs.push(result);
        if (result.code !== 0) break;
      }
      const last = runs[runs.length - 1] || { code: 1, stdout: "", stderr: "pdflatex did not run" };
      resolve({
        code: last.code,
        passes: runs.length,
        stdout: runs.map((run) => run.stdout || "").join("\n").trim(),
        stderr: runs.map((run) => run.stderr || "").join("\n").trim(),
      });
    })().catch((error) => resolve({ code: 1, stdout: "", stderr: String(error?.message || error) }));
  });
}

function removePath(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch (error) {
    log.warn(`[report] failed to remove path ${targetPath}: ${error?.message || error}`);
  }
}

function cleanupRenderWorkspace(renderWorkspaceDir) {
  removePath(renderWorkspaceDir);
}

function cleanupReportSidecars(outPath) {
  const dirName = path.dirname(outPath);
  const ext = path.extname(outPath).toLowerCase();
  const baseName = path.basename(outPath, ext);

  const sidecarNames = [`${baseName}_files`];
  if (ext === ".pdf") {
    sidecarNames.push(
      `${baseName}.tex`,
      `${baseName}.aux`,
      `${baseName}.log`,
      `${baseName}.out`,
      `${baseName}.toc`,
      `${baseName}.lof`,
      `${baseName}.lot`,
      `${baseName}.fls`,
      `${baseName}.fdb_latexmk`,
      `${baseName}.synctex.gz`
    );
  }

  for (const sidecarName of sidecarNames) {
    removePath(path.join(dirName, sidecarName));
  }
}

function cleanupExpiredEntries(dirPath, { maxAgeMs, keepNames = new Set(), allowedExts = null } = {}) {
  if (!fs.existsSync(dirPath)) return;

  const cutoff = Date.now() - maxAgeMs;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (keepNames.has(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.mtimeMs > cutoff) continue;

    if (entry.isDirectory()) {
      removePath(fullPath);
      continue;
    }

    if (allowedExts && !allowedExts.has(path.extname(entry.name).toLowerCase())) continue;
    removePath(fullPath);
  }
}

function cleanupExpiredReportArtifacts() {
  ensureDir(REPORTS_DIR);
  ensureDir(RENDER_RUNTIME_DIR);

  cleanupExpiredEntries(RENDER_RUNTIME_DIR, { maxAgeMs: RENDER_RETENTION_MS });
  cleanupExpiredEntries(REPORTS_DIR, {
    maxAgeMs: REPORT_RETENTION_MS,
    keepNames: REPORT_ASSET_FILES,
    allowedExts: new Set([".pdf", ".html", ".tex", ".aux", ".log", ".out", ".toc", ".lof", ".lot", ".fls", ".gz"]),
  });
}

function startReportCleanupLoop() {
  if (reportCleanupLoopStarted) return;
  reportCleanupLoopStarted = true;

  cleanupExpiredReportArtifacts();

  if (REPORT_CLEANUP_INTERVAL_MS <= 0) return;

  const timer = setInterval(() => {
    cleanupExpiredReportArtifacts();
  }, REPORT_CLEANUP_INTERVAL_MS);

  if (typeof timer.unref === "function") timer.unref();
}

function reportTemplateKey(template) {
  return path.basename(String(template || "")).toLowerCase().replace(/\.rmd$/i, "");
}

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

function deriveReportFilterValue({ reqBody = {}, session = {}, reportQueryParams = null }) {
  if (hasFilterValue(reportQueryParams?.filters)) return reportQueryParams.filters;
  if (hasFilterValue(reqBody?.caseFilter)) {
    return { caseFilter: reqBody.caseFilter, followUpTimeRange: reqBody.followUpTimeRange ?? null };
  }
  if (hasFilterValue(reqBody?.filters)) return reqBody.filters;
  if (hasFilterValue(session?.lastQueryFilters)) return session.lastQueryFilters;
  if (hasFilterValue(session?.filters)) return session.filters;
  return {};
}

function deriveReportFilterSummary({ reqBody = {}, session = {}, reportQueryParams = null }) {
  const filterValue = deriveReportFilterValue({ reqBody, session, reportQueryParams });
  return hasFilterValue(filterValue) ? compactSerialize(filterValue) : "";
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();

  if (forwardedProto && forwardedHost) return `${forwardedProto}://${forwardedHost}`;

  const host = req.get("host");
  if (!host) return "";

  return `${req.protocol}://${host}`;
}

function guessGuppyCandidates() {
  const fromConfig = config?.guppyConfig?.host;
  const normalized = String(fromConfig || "").replace(/\/+$/, "");
  const configCandidates = [];
  if (normalized) {
    if (normalized.endsWith("/graphql")) {
      configCandidates.push(normalized);
    } else {
      configCandidates.push(normalized);
      configCandidates.push(`${normalized}/graphql`);
    }
  }

  const cands = [
    ...configCandidates,
    process.env.GUPPY_GRAPHQL_URL,
    process.env.GUPPY_URL,
    process.env.ANAGINE_GUPPY_HOST,
    "http://guppy-service/graphql",
    "http://guppy-service/guppy/graphql",
    "http://revproxy-service/guppy/graphql",
  ];
  return cands.filter(Boolean);
}

const REPORT_ROUTE_CONFIGS = {
  participants: {
    reportView: "participants",
    forcedIndex: "case",
    defaultTemplate: "baseline_clinical_summary_report.rmd",
    defaultOutPrefix: "participants_report",
  },
  followUps: {
    reportView: "follow_ups",
    forcedIndex: "follow_up",
    defaultTemplate: "baseline_clinical_summary_report.rmd",
    defaultOutPrefix: "follow_ups_report",
  },
  biospecimens: {
    reportView: "biospecimens",
    forcedIndex: "aliquot",
    defaultTemplate: "baseline_clinical_summary_report.rmd",
    defaultOutPrefix: "biospecimens_report",
  },
  labResults: {
    reportView: "lab_results",
    forcedIndex: "molecular_test",
    defaultTemplate: "baseline_clinical_summary_report.rmd",
    defaultOutPrefix: "lab_results_report",
  },
};

function makeReportQueryParams(body = {}, routeConfig = {}) {
  const { filters = null, fields = null, index = null } = body;
  const forcedIndex = routeConfig?.forcedIndex || null;
  const hasReportParams =
    Boolean(forcedIndex) ||
    "filters" in body ||
    "fields" in body ||
    "index" in body;

  if (!hasReportParams) return null;

  return {
    filters: filters ?? {},
    fields: Array.isArray(fields) ? fields : [],
    index: forcedIndex || index || "case",
  };
}

async function handleReportRequest(req, res, { userSessions, routeConfig = {} }) {
  const timing = createReportTiming();
  const requestId = `report_${timing.startedAt}_${Math.random().toString(36).slice(2, 8)}`;
  const reportView = routeConfig.reportView || "generic";
  let template = routeConfig.defaultTemplate || "basic_report.rmd";
  let fmt = "pdf";
  let outFile = "";
  let username = "";
  let reportQueryParams = null;
  let reportFilters = {};
  let meta = null;

  try {
    const {
      template: requestedTemplate = null,
      format = "pdf",
      outName = null,
      caseFilter = null,
      followUpTimeRange = null,
    } = req.body || {};

    template = requestedTemplate || routeConfig.defaultTemplate || "basic_report.rmd";
    username = req.user;
    if (!username) {
      const payload = { status: "error", error: "No user on req.user" };
      logReportRuntime({
        req,
        requestId,
        username: "anonymous",
        status: 400,
        template,
        reportView,
        sourceIndex: null,
        outFile,
        format: fmt,
        fetchedCount: null,
        filters: reportFilters,
        startedAt: timing.startedAt,
        timings: timing.timings,
        errorType: reportErrorType(400, payload),
        errorMessage: payload.error,
      });
      return res.status(400).json(payload);
    }

    const session = userSessions[username] || {};
    const kernel = session.kernel || "UNKNOWN";
    reportQueryParams = makeReportQueryParams(req.body || {}, routeConfig);
    reportFilters = deriveReportFilterValue({
      reqBody: req.body || {},
      session,
      reportQueryParams,
    });

    const setupStart = Date.now();
    const tplPath = resolveTemplatePath(template);
    if (!tplPath) {
      log.error(`[report] Template not found: ${template}, TEMPLATES_DIR=${TEMPLATES_DIR}`);
      const payload = { status: "error", error: `Template not found: ${template}` };
      logReportRuntime({
        req,
        requestId,
        username,
        status: 404,
        template,
        reportView,
        sourceIndex: reportQueryParams?.index || null,
        outFile,
        format: fmt,
        fetchedCount: null,
        filters: reportFilters,
        startedAt: timing.startedAt,
        timings: timing.timings,
        errorType: reportErrorType(404, payload),
        errorMessage: payload.error,
      });
      return res.status(404).json(payload);
    }

    ensureDir(REPORTS_DIR);
    ensureDir(RENDER_RUNTIME_DIR);
    syncTemplateAssetsToReportsDir();
    cleanupExpiredReportArtifacts();
    timing.mark("report.setup", setupStart, {
      template,
      reportView: routeConfig.reportView || "generic",
    });

    const reportFilterSummary = deriveReportFilterSummary({
      reqBody: req.body || {},
      session,
      reportQueryParams,
    });
    if (typeof log.updateRequestContext === "function") {
      log.updateRequestContext({
        username,
        url: req.originalUrl || req.url,
        filters: reportFilterSummary,
      });
    }

    const requestedFmt = String(format || "").toLowerCase();
    const defaultFmt = String(process.env.REPORT_DEFAULT_FORMAT || "pdf").toLowerCase();
    const forcedFmt = String(process.env.REPORT_FORCE_FORMAT || "").toLowerCase();
    const templateKey = reportTemplateKey(template);
    const templateForcedFmt = templateKey === "baseline_clinical_summary_report" ? "pdf" : "";
    fmt = templateForcedFmt || forcedFmt || requestedFmt || defaultFmt;
    if (!["html", "pdf"].includes(fmt)) {
      const payload = { status: "error", error: "format must be 'html' or 'pdf'" };
      logReportRuntime({
        req,
        requestId,
        username,
        status: 400,
        template,
        reportView,
        sourceIndex: reportQueryParams?.index || null,
        outFile,
        format: fmt,
        fetchedCount: null,
        filters: reportFilters,
        startedAt: timing.startedAt,
        timings: timing.timings,
        errorType: reportErrorType(400, payload),
        errorMessage: payload.error,
      });
      return res.status(400).json(payload);
    }

    const ext = fmt === "pdf" ? "pdf" : "html";
    const outputFormat = fmt === "pdf" ? "latex_document" : "html_document";
    const outputOptions = renderOutputOptions(template, fmt);

    const ts = Date.now();
    const defaultOutName = routeConfig.defaultOutPrefix
      ? `${routeConfig.defaultOutPrefix}_${ts}`
      : `report_${ts}`;
    const base = safeName(outName ? outName : defaultOutName);
    outFile = base.endsWith(`.${ext}`) ? base : `${base}.${ext}`;
    const outPath = path.join(REPORTS_DIR, outFile);
    const texFile = fmt === "pdf" ? `${path.basename(outFile, ".pdf")}.tex` : "";
    const texPath = texFile ? path.join(REPORTS_DIR, texFile) : "";
    const renderOutFile = fmt === "pdf" ? texFile : outFile;

    cleanupReportSidecars(outPath);
    removePath(outPath);

    logReportUsageStart({
      req,
      requestId,
      username,
      template,
      reportView,
      sourceIndex: reportQueryParams?.index || null,
      format: fmt,
      filters: reportFilters,
    });

    const guppyHeaders = req.token ? { Authorization: `Bearer ${req.token}` } : {};

    const buildMetaStart = Date.now();
    meta = await buildReportMeta(template, {
      username,
      session,
      kernel,
      reportView: routeConfig.reportView || null,
      reqBody: {
        ...(req.body || {}),
        caseFilter,
        followUpTimeRange,
      },
      reportQueryParams,
      guppyUrlCandidates: guessGuppyCandidates(),
      guppyHeaders,
      timings: timing.timings,
    });
    timing.mark("report.buildMeta.total", buildMetaStart, {
      fetchedCount: meta?.fetchedCount ?? null,
      reportView: routeConfig.reportView || null,
      sourceIndex: reportQueryParams?.index || null,
    });

    const renderPrepStart = Date.now();
    const renderWorkspaceDir = path.join(RENDER_RUNTIME_DIR, `render_${ts}`);
    ensureDir(renderWorkspaceDir);

    const metaPath = path.join(renderWorkspaceDir, `meta_${ts}.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta), "utf-8");

    const renderRPath = path.join(renderWorkspaceDir, `render_${ts}.R`);
    const renderR = `
suppressPackageStartupMessages({
  library(rmarkdown)
  library(jsonlite)
})
meta <- jsonlite::fromJSON("${metaPath.replace(/\\/g, "/")}")

rmarkdown::render(
  input = "${tplPath.replace(/\\/g, "/")}",
  output_format = "${outputFormat}",
${outputOptions}  # keep template-specific options (e.g. TOC) when format is forced from API
  output_dir = "${REPORTS_DIR.replace(/\\/g, "/")}",
  intermediates_dir = "${renderWorkspaceDir.replace(/\\/g, "/")}",
  knit_root_dir = "${path.dirname(tplPath).replace(/\\/g, "/")}",
  output_file = "${renderOutFile}",
  params = list(meta_json = jsonlite::toJSON(meta, auto_unbox=TRUE))
)
`;
    fs.writeFileSync(renderRPath, renderR, "utf-8");
    timing.mark("report.render.prepare", renderPrepStart, {
      renderWorkspaceDir,
      metaBytes: Buffer.byteLength(JSON.stringify(meta), "utf-8"),
    });

    const rscriptStart = Date.now();
    const child = spawn("Rscript", [renderRPath], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", async (code) => {
      timing.mark("report.render.rscript", rscriptStart, {
        code,
        stdoutBytes: Buffer.byteLength(stdout, "utf-8"),
        stderrBytes: Buffer.byteLength(stderr, "utf-8"),
      });

      const finish = (status, payload) => {
        const cleanupStart = Date.now();
        cleanupRenderWorkspace(renderWorkspaceDir);
        cleanupReportSidecars(outPath);
        cleanupExpiredReportArtifacts();
        timing.mark("report.cleanup", cleanupStart, { status });
        logReportTiming({
          requestId,
          status,
          template,
          reportView,
          outFile,
          format: fmt,
          startedAt: timing.startedAt,
          timings: timing.timings,
        });
        logReportRuntime({
          req,
          requestId,
          username,
          status,
          template,
          reportView,
          sourceIndex: payload?.sourceIndex ?? reportQueryParams?.index ?? meta?.__debug?.sourceIndex ?? null,
          outFile,
          format: fmt,
          fetchedCount: payload?.fetchedCount ?? meta?.fetchedCount ?? null,
          filters: reportFilters,
          startedAt: timing.startedAt,
          timings: timing.timings,
          errorType: reportErrorType(status, payload),
          errorMessage: status === 200 ? null : String(payload?.error || ""),
        });
        return status === 200 ? res.json(payload) : res.status(status).json(payload);
      };

      if (code !== 0) {
        const errMsg = "Rmarkdown render failed";
        log.error(`[report] ${errMsg} code=${code} outFile=${renderOutFile} stderr=${stderr.slice(-500)}`);
        return finish(500, {
          status: "error",
          error: errMsg,
          code,
          outPath,
          fileExists: fs.existsSync(outPath),
          stderr: stderr.slice(-4000),
          stdout: stdout.slice(-4000),
          metaDebug: meta?.__debug || null,
        });
      }

      if (ext === "pdf") {
        if (!fs.existsSync(texPath)) {
          const errMsg = "Rmarkdown finished but TeX output file missing";
          log.error(`[report] ${errMsg} texPath=${texPath} stderr=${stderr.slice(-500)}`);
          return finish(500, {
            status: "error",
            error: errMsg,
            code,
            outPath,
            texPath,
            fileExists: false,
            stderr: stderr.slice(-4000),
            stdout: stdout.slice(-4000),
            metaDebug: meta?.__debug || null,
          });
        }

        const pdflatexStart = Date.now();
        const compile = await runPdflatexCompile(path.basename(texPath), REPORTS_DIR);
        timing.mark("report.render.pdflatex", pdflatexStart, {
          code: compile.code,
          passes: compile.passes,
          stdoutBytes: Buffer.byteLength(compile.stdout || "", "utf-8"),
          stderrBytes: Buffer.byteLength(compile.stderr || "", "utf-8"),
        });

        if (compile.code !== 0 || !fs.existsSync(outPath)) {
          const errMsg = "pdflatex compile failed";
          log.error(
            `[report] ${errMsg} code=${compile.code} outPath=${outPath} stderr=${String(compile.stderr || "").slice(-500)}`
          );
          return finish(500, {
            status: "error",
            error: errMsg,
            code: compile.code,
            outPath,
            texPath,
            fileExists: fs.existsSync(outPath),
            stderr: String(compile.stderr || stderr).slice(-4000),
            stdout: String(compile.stdout || stdout).slice(-4000),
            metaDebug: meta?.__debug || null,
          });
        }
      }

      const exists = fs.existsSync(outPath);

      if (!exists) {
        const errMsg = "Rmarkdown finished but output file missing";
        log.error(`[report] ${errMsg} code=${code} outPath=${outPath} stderr=${stderr.slice(-500)}`);
        return finish(500, {
          status: "error",
          error: errMsg,
          code,
          outPath,
          fileExists: exists,
          stderr: stderr.slice(-4000),
          stdout: stdout.slice(-4000),
          metaDebug: meta?.__debug || null,
        });
      }

      const reportPath = `/anagine/reports/${outFile}`;
      const reportPathLegacy = `/reports/${outFile}`;
      const origin = requestOrigin(req);
      const reportUrl = origin ? `${origin}${reportPath}` : reportPath;
      const reportUrlLegacy = origin ? `${origin}${reportPathLegacy}` : reportPathLegacy;

      return finish(200, {
        status: "ok",
        reportPath,
        reportPathLegacy,
        reportUrl,
        reportUrlLegacy,
        format: fmt,
        fetchedCount: meta?.fetchedCount ?? null,
        reportView: routeConfig.reportView || null,
        sourceIndex: reportQueryParams?.index || null,
        renderWarnings: "",
      });
    });
  } catch (e) {
    log.error("[report] Exception:", e?.message || e, e?.stack);
    logReportTiming({
      requestId,
      status: 500,
      template,
      reportView,
      outFile,
      format: fmt,
      startedAt: timing.startedAt,
      timings: timing.timings,
    });
    const payload = { status: "error", error: String(e?.message || e) };
    logReportRuntime({
      req,
      requestId,
      username: username || req.user || "anonymous",
      status: 500,
      template,
      reportView,
      sourceIndex: reportQueryParams?.index ?? meta?.__debug?.sourceIndex ?? null,
      outFile,
      format: fmt,
      fetchedCount: meta?.fetchedCount ?? null,
      filters: reportFilters,
      startedAt: timing.startedAt,
      timings: timing.timings,
      errorType: "exception",
      errorMessage: payload.error,
    });
    return res.status(500).json(payload);
  }
}

export default function createReportRouter({ checkAuth, userSessions }) {
  startReportCleanupLoop();
  const router = express.Router();

  router.get("/report", (req, res) => {
    return res.status(200).json({
      status: "info",
      message: "Use POST /anagine/report to generate a report, then open reportUrl or reportPath from the JSON response.",
    });
  });

  router.post("/report", checkAuth, async (req, res) => {
    return handleReportRequest(req, res, { userSessions, routeConfig: {} });
  });

  router.post("/report/participants", checkAuth, async (req, res) => {
    return handleReportRequest(req, res, {
      userSessions,
      routeConfig: REPORT_ROUTE_CONFIGS.participants,
    });
  });

  router.post("/report/follow-ups", checkAuth, async (req, res) => {
    return handleReportRequest(req, res, {
      userSessions,
      routeConfig: REPORT_ROUTE_CONFIGS.followUps,
    });
  });

  router.post("/report/biospecimens", checkAuth, async (req, res) => {
    return handleReportRequest(req, res, {
      userSessions,
      routeConfig: REPORT_ROUTE_CONFIGS.biospecimens,
    });
  });

  router.post("/report/lab-results", checkAuth, async (req, res) => {
    return handleReportRequest(req, res, {
      userSessions,
      routeConfig: REPORT_ROUTE_CONFIGS.labResults,
    });
  });

  return router;
}
