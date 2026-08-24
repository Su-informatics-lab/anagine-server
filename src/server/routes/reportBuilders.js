// reportBuilders.js - from upstream
import path from "path";
import { fetchAllFromGuppy } from "../utils/guppyClient.js";

let _cachedGuppyUrl = null;

function templateKey(template) {
  const base = path.basename(String(template || "")).toLowerCase();
  return base.replace(/\.rmd$/i, "");
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function uniqueNonEmpty(arr) {
  return [...new Set(safeArray(arr).map((v) => String(v || "").trim()).filter(Boolean))];
}

function withRequestedBy(meta, ctx) {
  return {
    requested_by: ctx?.username || "",
    ...meta,
  };
}

function recordTiming(ctxOrTimings, label, startMs, extra = {}) {
  const timings = Array.isArray(ctxOrTimings) ? ctxOrTimings : ctxOrTimings?.timings;
  if (!Array.isArray(timings)) return;
  timings.push({
    label,
    ms: Date.now() - startMs,
    ...extra,
  });
}

function parseUnknownGuppyFields(errorLike) {
  const raw = String(errorLike?.message || errorLike || "");
  const msg = raw.replace(/\\"/g, "\"").replace(/\\n/g, " ");
  const out = new Set();
  const patterns = [
    /Cannot query field "([^"]+)"/g,
    /Cannot query field '([^']+)'/g,
    /Field "([^"]+)" is not defined/g,
    /Field '([^']+)' is not defined/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(msg)) !== null) {
      if (m[1]) out.add(m[1]);
    }
  }
  const invalidFieldsMatch = msg.match(/Invalid fields:\s*([^]+?)(?:$|Error:|Guppy)/i);
  if (invalidFieldsMatch && invalidFieldsMatch[1]) {
    const quoted = [...invalidFieldsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const field of quoted) out.add(field);
  }
  return [...out];
}

async function fetchAllWithFieldFallback({ guppyUrl, headers = {}, index, filters = {}, fields = [] }) {
  let activeFields = uniqueNonEmpty(fields);
  const droppedFields = [];
  let lastErr = null;

  while (activeFields.length > 0) {
    try {
      const { rows, totalCount } = await fetchAllFromGuppy({
        guppyUrl,
        headers,
        index,
        filters,
        fields: activeFields,
      });
      return { rows, totalCount, usedFields: activeFields, droppedFields };
    } catch (e) {
      lastErr = e;
      const unknownFields = parseUnknownGuppyFields(e);
      if (unknownFields.length === 0) break;

      const nextFields = activeFields.filter((f) => !unknownFields.includes(f));
      if (nextFields.length === activeFields.length) break;

      for (const f of unknownFields) {
        if (activeFields.includes(f) && !droppedFields.includes(f)) droppedFields.push(f);
      }
      activeFields = nextFields;
    }
  }

  throw lastErr || new Error("Failed to query Guppy for report");
}

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function pickCaseMeldValue(raw) {
  if (Array.isArray(raw)) {
    const nums = raw.map((v) => Number(v)).filter((n) => Number.isFinite(n));
    if (!nums.length) return null;
    return Math.max(...nums);
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function getFetch() {
  if (typeof fetch !== "undefined") return fetch;
  const mod = await import("node-fetch");
  return mod.default;
}

async function guppyPost(url, payload, headers = {}) {
  const _fetch = await getFetch();
  const resp = await _fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Guppy non-JSON response (${resp.status}): ${text.slice(0, 300)}`);
  }
  if (!resp.ok) {
    throw new Error(`Guppy error (${resp.status}): ${JSON.stringify(json.errors || json).slice(0, 800)}`);
  }
  // Like Explorer: tolerate GraphQL errors when we have data (e.g. laboratory_test "String cannot represent value: []")
  if (json.errors && (!json.data || Object.keys(json.data).length === 0)) {
    throw new Error(`Guppy error: ${JSON.stringify(json.errors).slice(0, 800)}`);
  }
  return json;
}

async function resolveGuppyUrl(candidates = [], headers = {}) {
  if (_cachedGuppyUrl) return _cachedGuppyUrl;

  const list = candidates.filter(Boolean);
  const fallbacks = [
    "http://guppy-service/graphql",
    "http://guppy-service/guppy/graphql",
  ];
  const toTry = list.length ? list : fallbacks;

  for (const url of toTry) {
    try {
      const out = await guppyPost(url, { query: "{ _aggregation { case { _totalCount } } }" }, headers);
      if (out?.data?._aggregation?.case?._totalCount !== undefined) {
        _cachedGuppyUrl = url;
        return url;
      }
    } catch (e) {
      // try next
    }
  }
  throw new Error(`Could not reach Guppy GraphQL. Tried: ${toTry.join(", ")}`);
}

// Minimal fields for case (basic_report fallback)
const DEFAULT_CASE_FIELDS = [
  "pat_id", "_case_id", "project_id", "study_site",
];

// Case fields for demo_age_meld_report (must include year_of_birth, meld_score)
const DEMO_AGE_MELD_CASE_FIELDS = [
  "pat_id", "_case_id", "project_id", "study_site",
  "year_of_birth", "meld_score",
];

// Case fields for test_report (primary_site, Sex analysis - IPO/Gen3 style)
const TEST_REPORT_CASE_FIELDS = [
  "pat_id", "_case_id", "project_id", "primary_site", "gender",
  "primary_site_of_disease", "sex", "demographics.gender",
  "diagnoses.primary_site",
];

const BASELINE_CLINICAL_CASE_FIELDS = [
  "pat_id",
  "_case_id",
  "project_id",
  "study_site",
  "study_name",
  "cohort",
  "actarm",
  "aki_status",
  "days_180_aki",
  "days_180_survival",
  "days_90_aki",
  "days_90_survival",
  "days_to_aki",
  "days_to_death",
  "vital_status",
  "gender",
  "race",
  "ethnicity",
  "age_at_index",
  "drinking_frequency",
  "drinks_per_day",
];

const BASELINE_CLINICAL_FOLLOW_UP_FIELDS = [
  "pat_id",
  "project_id",
  "follow_up_id",
  "visit_day",
  "bmi",
  "child_pugh_score",
  "maddreys_score",
  "meld_score",
  "tlfb_drinking_days",
  "tlfb_number_drinks",
];

const BASELINE_CLINICAL_ALIQUOT_FIELDS = [
  "project_id",
  "aliquot_id",
  "specimen_type",
  "follow_up_id",
  "visit_day",
  "pat_id",
  "case_arm",
  "case_group",
  "cohort",
  "study_site",
  "study_name",
  "gender",
  "race",
  "ethnicity",
  "age_at_index",
  "lab_id",
  "lab_name",
  "PI_name",
  "name_of_institute",
];

const BASELINE_CLINICAL_LAB_FIELDS = [
  "pat_id",
  "project_id",
  "follow_up_id",
  "laboratory_test",
  "test_value",
  "test_unit",
];

const BASELINE_CLINICAL_MOLECULAR_TEST_SOURCE_FIELDS = [
  "project_id",
  "molecular_test_id",
  "laboratory_test",
  "test_result",
  "test_value",
  "test_unit",
  "follow_up_id",
  "visit_day",
  "pat_id",
  "case_arm",
  "case_group",
  "cohort",
  "study_site",
  "study_name",
  "gender",
  "race",
  "ethnicity",
  "lab_id",
  "lab_name",
  "PI_name",
  "name_of_institute",
];

const BASELINE_CLINICAL_EXPECTED_FIELDS = [
  "age_at_index",
  "gender",
  "race",
  "bmi",
  "alcohol_use_baseline",
  "tlfb_number_drinks",
  "tlfb_drinking_days",
  "meld_score",
  "child_pugh_score",
  "maddreys_score",
  "estimated_gfr_mdrd",
  "albumin",
  "total_bilirubin",
  "direct_bilirubin",
  "creatinine",
  "alt",
  "ast",
  "alkaline_phosphatase",
  "total_protein",
  "hemoglobin",
  "total_wbc",
  "platelet_count",
  "mcv",
  "inr",
  "pt_seconds",
];

const BASELINE_CLINICAL_LAB_DERIVED_FIELDS = [
  "estimated_gfr_mdrd",
  "albumin",
  "total_bilirubin",
  "direct_bilirubin",
  "creatinine",
  "alt",
  "ast",
  "alkaline_phosphatase",
  "total_protein",
  "hemoglobin",
  "total_wbc",
  "platelet_count",
  "mcv",
  "inr",
  "pt_seconds",
];

const BASELINE_CLINICAL_UNAVAILABLE_FIELDS = [];

const BASELINE_CLINICAL_LAB_TEST_ALIASES = {
  albumin: ["albumin", "serum albumin"],
  total_bilirubin: ["total bilirubin"],
  direct_bilirubin: ["direct bilirubin"],
  creatinine: ["creatinine", "serum creatinine"],
  estimated_gfr_mdrd: ["estimated gfr", "egfr", "estimated gfr (mdrd)"],
  alt: ["alt"],
  ast: ["ast"],
  alkaline_phosphatase: ["alkaline phosphatase"],
  total_protein: ["total protein"],
  hemoglobin: ["hemoglobin"],
  total_wbc: ["wbc"],
  platelet_count: ["platelets"],
  mcv: ["mcv"],
  inr: ["inr"],
  pt_seconds: ["prothrombin time", "pt"],
};

// Default fields by index when session.lastQueryFields is empty
const DEFAULT_FIELDS_BY_INDEX = {
  case: DEFAULT_CASE_FIELDS,
  subject: ["submitter_id", "project_id"],
  follow_up: ["submitter_id", "project_id", "follow_up_id"],
};

function chunkArray(arr, size = 200) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toFiniteNumber(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const nums = raw
      .map((v) => {
        if (v == null) return null;
        if (typeof v === "string" && v.trim() === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      })
      .filter((n) => n != null);
    if (!nums.length) return null;
    return nums[0];
  }
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueBy(rows, keyFn) {
  const out = [];
  const seen = new Set();
  for (const row of safeArray(rows)) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function countByValue(rows, getter) {
  const counts = new Map();
  for (const row of safeArray(rows)) {
    const key = String(getter(row) ?? "").trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([value, count]) => ({ value, count }));
}

function extractParticipantId(row) {
  return String(
    row?.pat_id ??
    row?.submitter_id ??
    row?._subject_id ??
    row?._case_id ??
    ""
  ).trim();
}

function baselineVisitPriority(row) {
  const visitDay = toFiniteNumber(row?.visit_day);
  if (!Number.isFinite(visitDay)) return [3, Number.POSITIVE_INFINITY];
  if (visitDay === 0) return [0, 0];
  if (visitDay > 0) return [1, visitDay];
  return [2, Math.abs(visitDay)];
}

function pickBaselineFollowUps(rows) {
  const byPat = new Map();

  for (const row of safeArray(rows)) {
    const patId = extractParticipantId(row);
    if (!patId) continue;

    const current = byPat.get(patId);
    if (!current) {
      byPat.set(patId, row);
      continue;
    }

    const nextScore = baselineVisitPriority(row);
    const curScore = baselineVisitPriority(current);
    const nextVisit = toFiniteNumber(row?.visit_day) ?? Number.POSITIVE_INFINITY;
    const curVisit = toFiniteNumber(current?.visit_day) ?? Number.POSITIVE_INFINITY;
    const nextId = String(row?.follow_up_id || "");
    const curId = String(current?.follow_up_id || "");

    const isBetter =
      nextScore[0] < curScore[0] ||
      (nextScore[0] === curScore[0] && nextScore[1] < curScore[1]) ||
      (nextScore[0] === curScore[0] && nextScore[1] === curScore[1] && nextVisit < curVisit) ||
      (nextScore[0] === curScore[0] && nextScore[1] === curScore[1] && nextVisit === curVisit && nextId < curId);

    if (isBetter) byPat.set(patId, row);
  }

  return [...byPat.values()];
}

function inferAlcoholUseBaseline(row) {
  const drinkingDays = toFiniteNumber(row?.tlfb_drinking_days);
  const numberDrinks = toFiniteNumber(row?.tlfb_number_drinks);
  const drinksPerDay = toFiniteNumber(row?.drinks_per_day);
  const drinkingFrequency = normalizeText(row?.drinking_frequency);

  if ([drinkingDays, numberDrinks, drinksPerDay].some((n) => Number.isFinite(n) && n > 0)) return "Yes";
  if (
    [drinkingDays, numberDrinks, drinksPerDay].some((n) => Number.isFinite(n)) &&
    [drinkingDays, numberDrinks, drinksPerDay].every((n) => !Number.isFinite(n) || n === 0)
  ) {
    return "No";
  }

  if (drinkingFrequency) {
    if (["never", "none", "0", "0 days"].includes(drinkingFrequency)) return "No";
    return "Yes";
  }

  return null;
}

function normalizeLabKey(name) {
  return normalizeText(name).replace(/\s+/g, " ");
}

function buildLabAliasLookup() {
  const lookup = new Map();
  for (const [field, aliases] of Object.entries(BASELINE_CLINICAL_LAB_TEST_ALIASES)) {
    for (const alias of aliases) lookup.set(normalizeLabKey(alias), field);
  }
  return lookup;
}

const BASELINE_CLINICAL_LAB_ALIAS_LOOKUP = buildLabAliasLookup();

function pivotLabRows(rows) {
  const byFollowUp = new Map();

  for (const row of safeArray(rows)) {
    const followUpId = String(row?.follow_up_id || "").trim();
    if (!followUpId) continue;

    const field = BASELINE_CLINICAL_LAB_ALIAS_LOOKUP.get(normalizeLabKey(row?.laboratory_test));
    if (!field) continue;

    const value = toFiniteNumber(row?.test_value);
    if (!Number.isFinite(value)) continue;

    if (!byFollowUp.has(followUpId)) {
      byFollowUp.set(followUpId, {
        follow_up_id: followUpId,
        pat_id: extractParticipantId(row),
      });
    }

    const current = byFollowUp.get(followUpId);
    current[field] = value;
    if (row?.test_unit != null && String(row.test_unit).trim() !== "") {
      current[`${field}_unit`] = String(row.test_unit).trim();
    }
  }

  return byFollowUp;
}

async function fetchByIdChunks({
  guppyUrl,
  headers = {},
  index,
  idField,
  ids = [],
  fields = [],
  timings = null,
  timingLabel = null,
}) {
  const totalStart = Date.now();
  const chunks = chunkArray(uniqueNonEmpty(ids), 200);
  const allRows = [];
  let totalCount = 0;
  let usedFields = [];
  const droppedFields = new Set();

  for (const chunk of chunks) {
    const chunkStart = Date.now();
    const out = await fetchAllWithFieldFallback({
      guppyUrl,
      headers,
      index,
      filters: {
        [idField]: {
          selectedValues: chunk,
        },
      },
      fields,
    });
    recordTiming(timings, timingLabel || `guppy.fetch.${index}.chunk`, chunkStart, {
      index,
      idField,
      chunkSize: chunk.length,
      rows: safeArray(out.rows).length,
      totalCount: Number(out.totalCount || 0),
      fieldCount: safeArray(out.usedFields).length,
      droppedFieldCount: safeArray(out.droppedFields).length,
    });

    allRows.push(...safeArray(out.rows));
    totalCount += Number(out.totalCount || 0);
    usedFields = out.usedFields || usedFields;
    for (const field of safeArray(out.droppedFields)) droppedFields.add(field);
  }

  return {
    rows: allRows,
    totalCount,
    usedFields,
    droppedFields: [...droppedFields],
    timingMs: Date.now() - totalStart,
  };
}

/**
 * Resolve query params: reportQueryParams (from Report body) > session (from prior /anagine/query).
 * Same params as using Explorer filters -> /anagine/query. Report can receive them directly.
 */
function resolveQueryParams(ctx) {
  const reportParams = ctx?.reportQueryParams;
  const session = ctx?.session || {};
  if (reportParams) {
    return {
      rawFilter: reportParams.filters ?? {},
      typeName: reportParams.index ?? "case",
      fields:
        safeArray(reportParams.fields).length > 0
          ? reportParams.fields
          : DEFAULT_FIELDS_BY_INDEX[reportParams.index || "case"] || DEFAULT_CASE_FIELDS,
    };
  }
  return {
    rawFilter: session.lastQueryFilters ?? session.filters ?? {},
    typeName: session.lastQueryIndex || "case",
    fields:
      safeArray(session.lastQueryFields).length > 0
        ? session.lastQueryFields
        : DEFAULT_FIELDS_BY_INDEX[session.lastQueryIndex || "case"] || DEFAULT_CASE_FIELDS,
  };
}

/**
 * Fetch all rows from Guppy using query params (from Report body or session).
 * Uses shared guppyClient.js - same logic as /anagine/query (fetchAll).
 */
async function fetchFromGuppyByParams(ctx) {
  const resolveStart = Date.now();
  const guppyUrl = await resolveGuppyUrl(ctx?.guppyUrlCandidates || [], ctx?.guppyHeaders || {});
  recordTiming(ctx, "buildMeta.resolveGuppyUrl", resolveStart, { guppyUrl });
  const guppyHeaders = ctx?.guppyHeaders || {};

  const { rawFilter, typeName, fields } = resolveQueryParams(ctx);

  const fetchStart = Date.now();
  const { rows, totalCount } = await fetchAllFromGuppy({
    guppyUrl,
    headers: guppyHeaders,
    index: typeName,
    filters: rawFilter,
    fields,
  });
  recordTiming(ctx, "buildMeta.fetch.queryParams", fetchStart, {
    index: typeName,
    rows: safeArray(rows).length,
    totalCount: Number(totalCount || 0),
    fieldCount: safeArray(fields).length,
  });

  return { rows, totalCount, rawFilter, typeName, guppyUrl };
}

async function buildBasicReportMeta(ctx) {
  const nowIso = new Date().toISOString();
  const session = ctx?.session || {};

  // Use reportQueryParams (from Report body) or session. Same flow as Use Explorer filters.
  const hasQueryParams =
    ctx?.reportQueryParams != null ||
    session.lastQueryIndex != null ||
    (session.lastQueryFilters != null && Object.keys(session.lastQueryFilters || {}).length > 0);

  if (hasQueryParams) {
    const { rows, totalCount, rawFilter, typeName, guppyUrl } = await fetchFromGuppyByParams(ctx);
    return withRequestedBy({
      generated_at: nowIso,
      kernel: ctx?.kernel || "UNKNOWN",
      template: ctx?.template || "basic_report",
      filters: rawFilter,
      fetchedCount: rows.length,
      fetchedData: rows,
      __debug: { totalCount, typeName, guppyUrl },
    }, ctx);
  }

  // Fallback: session.fetchedData (from /anagine/fetch)
  const fetchedData = safeArray(session.fetchedData);
  return withRequestedBy({
    generated_at: nowIso,
    kernel: ctx?.kernel || session.kernel || "UNKNOWN",
    template: ctx?.template || "basic_report",
    filters: session.filters || {},
    fetchedCount: fetchedData.length,
    fetchedData,
  }, ctx);
}

async function buildDemoAgeMeldMeta(ctx) {
  const nowIso = new Date().toISOString();
  const reqBody = ctx?.reqBody || {};
  const session = ctx?.session || {};

  const resolveStart = Date.now();
  const guppyUrl = await resolveGuppyUrl(ctx?.guppyUrlCandidates || [], ctx?.guppyHeaders || {});
  recordTiming(ctx, "buildMeta.resolveGuppyUrl", resolveStart, { guppyUrl });
  const guppyHeaders = ctx?.guppyHeaders || {};

  // Same flow as Use Explorer filters: reportQueryParams (from Report body) > session > reqBody
  const reportParams = ctx?.reportQueryParams;
  const reportIndex = String(reportParams?.index || "").toLowerCase();
  const allowReportParams = !reportParams || !reportIndex || reportIndex === "case";
  const rawCaseFilter = allowReportParams && reportParams
    ? reportParams.filters ?? {}
    : isObject(reqBody.caseFilter)
      ? reqBody.caseFilter
      : session.lastQueryIndex === "case" && Object.keys(session.lastQueryFilters || {}).length > 0
        ? session.lastQueryFilters
        : isObject(session.filters)
          ? session.filters
          : {};
  const followUpTimeRange = isObject(reqBody.followUpTimeRange) ? reqBody.followUpTimeRange : null;

  // Fields: reportParams > reqBody > session (when index was case) > demo defaults
  const reqFields = safeArray(reqBody.caseFields || reqBody.fields);
  const reportFields = safeArray(reportParams?.fields);
  const sessionFields = safeArray(session.lastQueryFields);
  const requestedFields =
    allowReportParams && reportFields.length > 0
      ? reportFields
      : reqFields.length > 0
        ? reqFields
        : session.lastQueryIndex === "case" && sessionFields.length > 0
          ? sessionFields
          : [];
  // Keep user requested fields, but always include required fields for this template.
  const caseFields = uniqueNonEmpty([...requestedFields, ...DEMO_AGE_MELD_CASE_FIELDS]);

  const caseFetchStart = Date.now();
  const {
    rows: cases,
    totalCount: caseTotal,
    usedFields: caseFieldsUsed,
    droppedFields: droppedCaseFields,
  } = await fetchAllWithFieldFallback({
    guppyUrl,
    headers: guppyHeaders,
    index: "case",
    filters: rawCaseFilter,
    fields: caseFields,
  });
  recordTiming(ctx, "buildMeta.fetch.demo.case", caseFetchStart, {
    index: "case",
    rows: safeArray(cases).length,
    totalCount: Number(caseTotal || 0),
    fieldCount: safeArray(caseFieldsUsed).length,
    droppedFieldCount: safeArray(droppedCaseFields).length,
  });

  const transformStart = Date.now();
  const fetchedData = cases.map((c) => {
    const meldScoreValue = pickCaseMeldValue(c?.meld_score);
    return {
      ...c,
      meld_score: meldScoreValue,
      meld_score_raw: c?.meld_score ?? null,
    };
  });
  recordTiming(ctx, "buildMeta.transform.demo", transformStart, { rows: fetchedData.length });

  return withRequestedBy({
    generated_at: nowIso,
    kernel: ctx?.kernel || "UNKNOWN",
    template: ctx?.template || "demo_age_meld_report",
    filters: { caseFilter: rawCaseFilter, followUpTimeRange },
    fetchedCount: fetchedData.length,
    fetchedData,
    __debug: {
      caseTotal,
      followUpTimeRangeIgnored: !!followUpTimeRange,
      meldSource: "case.meld_score",
      reportParamsIgnored: !allowReportParams,
      caseFields,
      caseFieldsUsed,
      droppedCaseFields,
      guppyUrl,
    },
  }, ctx);
}

/**
 * test_report: Guppy case data, primary_site + Sex analysis (IPO/Gen3 style).
 * Uses case index + TEST_REPORT_CASE_FIELDS.
 * Filters: reportQueryParams > session > {} (empty = all cases).
 */
async function buildTestReportMeta(ctx) {
  const nowIso = new Date().toISOString();
  const session = ctx?.session || {};
  const reqBody = ctx?.reqBody || {};
  const reportParams = ctx?.reportQueryParams;
  const reportIndex = String(reportParams?.index || "").toLowerCase();
  const allowReportParams = !reportParams || !reportIndex || reportIndex === "case";

  const resolveStart = Date.now();
  const guppyUrl = await resolveGuppyUrl(ctx?.guppyUrlCandidates || [], ctx?.guppyHeaders || {});
  recordTiming(ctx, "buildMeta.resolveGuppyUrl", resolveStart, { guppyUrl });
  const guppyHeaders = ctx?.guppyHeaders || {};

  const rawCaseFilter = allowReportParams && reportParams
    ? reportParams.filters ?? {}
    : isObject(reqBody.caseFilter)
      ? reqBody.caseFilter
      : session.lastQueryIndex === "case" && Object.keys(session.lastQueryFilters || {}).length > 0
        ? session.lastQueryFilters
        : {};

  const reportFields = safeArray(reportParams?.fields);
  const sessionFields = safeArray(session.lastQueryFields);
  const requestedFields =
    allowReportParams && reportFields.length > 0
      ? reportFields
      : session.lastQueryIndex === "case" && sessionFields.length > 0
        ? sessionFields
        : [];
  // Keep user requested fields, but always include required fields for this template.
  const caseFields = uniqueNonEmpty([...requestedFields, ...TEST_REPORT_CASE_FIELDS]);

  const caseFetchStart = Date.now();
  const {
    rows: cases,
    totalCount: caseTotal,
    usedFields: caseFieldsUsed,
    droppedFields: droppedCaseFields,
  } = await fetchAllWithFieldFallback({
    guppyUrl,
    headers: guppyHeaders,
    index: "case",
    filters: rawCaseFilter,
    fields: caseFields,
  });
  recordTiming(ctx, "buildMeta.fetch.test.case", caseFetchStart, {
    index: "case",
    rows: safeArray(cases).length,
    totalCount: Number(caseTotal || 0),
    fieldCount: safeArray(caseFieldsUsed).length,
    droppedFieldCount: safeArray(droppedCaseFields).length,
  });

  return withRequestedBy({
    generated_at: nowIso,
    kernel: ctx?.kernel || "UNKNOWN",
    template: ctx?.template || "test_report",
    filters: { caseFilter: rawCaseFilter },
    fetchedCount: cases.length,
    fetchedData: cases,
    __debug: {
      caseTotal,
      reportParamsIgnored: !allowReportParams,
      caseFields,
      caseFieldsUsed,
      droppedCaseFields,
      guppyUrl,
      note: "test_report: primary_site + Sex analysis for case node",
    },
  }, ctx);
}

async function buildBaselineClinicalSummaryMeta(ctx) {
  const nowIso = new Date().toISOString();
  const reportParams = ctx?.reportQueryParams || {};
  const sourceIndex = String(reportParams?.index || "case").toLowerCase();
  const sourceFilters = reportParams?.filters ?? {};

  if (!["case", "follow_up", "aliquot", "molecular_test"].includes(sourceIndex)) {
    throw new Error(`baseline_clinical_summary_report only supports index='case', 'follow_up', 'aliquot', or 'molecular_test'; got '${sourceIndex}'`);
  }

  const resolveStart = Date.now();
  const guppyUrl = await resolveGuppyUrl(ctx?.guppyUrlCandidates || [], ctx?.guppyHeaders || {});
  recordTiming(ctx, "buildMeta.resolveGuppyUrl", resolveStart, { guppyUrl });
  const guppyHeaders = ctx?.guppyHeaders || {};

  const sourceFields =
    sourceIndex === "case"
      ? BASELINE_CLINICAL_CASE_FIELDS
      : sourceIndex === "follow_up"
        ? uniqueNonEmpty([...BASELINE_CLINICAL_FOLLOW_UP_FIELDS, "gender", "race", "ethnicity", "age_at_index"])
        : sourceIndex === "aliquot"
          ? BASELINE_CLINICAL_ALIQUOT_FIELDS
          : BASELINE_CLINICAL_MOLECULAR_TEST_SOURCE_FIELDS;

  const sourceFetchStart = Date.now();
  const sourceOut = await fetchAllWithFieldFallback({
    guppyUrl,
    headers: guppyHeaders,
    index: sourceIndex,
    filters: sourceFilters,
    fields: sourceFields,
  });
  recordTiming(ctx, "buildMeta.fetch.baseline.source", sourceFetchStart, {
    index: sourceIndex,
    rows: safeArray(sourceOut.rows).length,
    totalCount: Number(sourceOut.totalCount || 0),
    fieldCount: safeArray(sourceOut.usedFields).length,
    droppedFieldCount: safeArray(sourceOut.droppedFields).length,
  });

  const sourceTransformStart = Date.now();
  const sourceRows = uniqueBy(sourceOut.rows, (row) => {
    const patId = extractParticipantId(row);
    if (sourceIndex === "aliquot") return String(row?.aliquot_id || "").trim() || `${patId}::${row?.follow_up_id || ""}::${row?.specimen_type || ""}`;
    if (sourceIndex === "molecular_test") return String(row?.molecular_test_id || "").trim() || `${patId}::${row?.follow_up_id || ""}::${row?.laboratory_test || ""}::${row?.test_value || ""}`;
    return sourceIndex === "follow_up" ? `${patId}::${row?.follow_up_id || ""}` : patId;
  });
  const participantIds = uniqueNonEmpty(sourceRows.map((row) => extractParticipantId(row)));
  const selectedAliquotIds =
    sourceIndex === "aliquot"
      ? uniqueNonEmpty(sourceRows.map((row) => String(row?.aliquot_id || "").trim()))
      : [];
  const linkedFollowUpIdsFromAliquots =
    sourceIndex === "aliquot"
      ? uniqueNonEmpty(sourceRows.map((row) => String(row?.follow_up_id || "").trim()))
      : [];
  const linkedFollowUpIdsFromLabResults =
    sourceIndex === "molecular_test"
      ? uniqueNonEmpty(sourceRows.map((row) => String(row?.follow_up_id || "").trim()))
      : [];
  const biospecimenSummary =
    sourceIndex === "aliquot"
      ? {
          specimenTypeCounts: countByValue(sourceRows, (row) => row?.specimen_type),
          labCounts: countByValue(sourceRows, (row) => row?.PI_name ?? row?.lab_name ?? row?.name_of_institute),
          biospecimensPerParticipant: Object.entries(
            safeArray(sourceRows).reduce((acc, row) => {
              const patId = extractParticipantId(row);
              if (!patId) return acc;
              acc[patId] = (acc[patId] || 0) + 1;
              return acc;
            }, {})
          )
            .map(([pat_id, biospecimen_count]) => ({ pat_id, biospecimen_count }))
            .sort((a, b) => b.biospecimen_count - a.biospecimen_count || a.pat_id.localeCompare(b.pat_id)),
          biospecimensPerFollowUp: Object.entries(
            safeArray(sourceRows).reduce((acc, row) => {
              const followUpId = String(row?.follow_up_id || "").trim();
              if (!followUpId) return acc;
              acc[followUpId] = (acc[followUpId] || 0) + 1;
              return acc;
            }, {})
          )
            .map(([follow_up_id, biospecimen_count]) => ({ follow_up_id, biospecimen_count }))
            .sort((a, b) => b.biospecimen_count - a.biospecimen_count || a.follow_up_id.localeCompare(b.follow_up_id)),
          previewRows: safeArray(sourceRows).slice(0, 10).map((row) => ({
            aliquot_id: row?.aliquot_id ?? null,
            specimen_type: row?.specimen_type ?? null,
            lab_name: row?.PI_name ?? row?.lab_name ?? row?.name_of_institute ?? null,
            follow_up_id: row?.follow_up_id ?? null,
            pat_id: extractParticipantId(row) || null,
            study_site: row?.study_site ?? null,
          })),
        }
      : null;
  const labResultSummary =
    sourceIndex === "molecular_test"
      ? {
          laboratoryTestCounts: countByValue(sourceRows, (row) => row?.laboratory_test),
          unitCounts: countByValue(sourceRows, (row) => row?.test_unit),
          labCounts: countByValue(sourceRows, (row) => row?.PI_name ?? row?.lab_name ?? row?.name_of_institute),
          labResultsPerParticipant: Object.entries(
            safeArray(sourceRows).reduce((acc, row) => {
              const patId = extractParticipantId(row);
              if (!patId) return acc;
              acc[patId] = (acc[patId] || 0) + 1;
              return acc;
            }, {})
          )
            .map(([pat_id, lab_result_count]) => ({ pat_id, lab_result_count }))
            .sort((a, b) => b.lab_result_count - a.lab_result_count || a.pat_id.localeCompare(b.pat_id)),
          labResultsPerFollowUp: Object.entries(
            safeArray(sourceRows).reduce((acc, row) => {
              const followUpId = String(row?.follow_up_id || "").trim();
              if (!followUpId) return acc;
              acc[followUpId] = (acc[followUpId] || 0) + 1;
              return acc;
            }, {})
          )
            .map(([follow_up_id, lab_result_count]) => ({ follow_up_id, lab_result_count }))
            .sort((a, b) => b.lab_result_count - a.lab_result_count || a.follow_up_id.localeCompare(b.follow_up_id)),
          previewRows: safeArray(sourceRows).slice(0, 10).map((row) => ({
            molecular_test_id: row?.molecular_test_id ?? null,
            laboratory_test: row?.laboratory_test ?? null,
            test_value: row?.test_value ?? null,
            test_unit: row?.test_unit ?? null,
            lab_name: row?.PI_name ?? row?.lab_name ?? row?.name_of_institute ?? null,
            follow_up_id: row?.follow_up_id ?? null,
            pat_id: extractParticipantId(row) || null,
            study_site: row?.study_site ?? null,
          })),
        }
      : null;
  recordTiming(ctx, "buildMeta.transform.baseline.source", sourceTransformStart, {
    sourceRows: sourceRows.length,
    participantIds: participantIds.length,
  });

  const caseFetchStart = Date.now();
  const caseOut =
    sourceIndex === "case"
      ? {
          rows: sourceRows,
          totalCount: sourceOut.totalCount,
          usedFields: sourceOut.usedFields,
          droppedFields: sourceOut.droppedFields,
        }
      : await fetchByIdChunks({
          guppyUrl,
          headers: guppyHeaders,
          index: "case",
          idField: "pat_id",
          ids: participantIds,
          fields: BASELINE_CLINICAL_CASE_FIELDS,
          timings: ctx?.timings,
          timingLabel: "buildMeta.fetch.baseline.case.chunk",
        });
  recordTiming(ctx, "buildMeta.fetch.baseline.case.total", caseFetchStart, {
    index: "case",
    rows: safeArray(caseOut.rows).length,
    totalCount: Number(caseOut.totalCount || 0),
    fieldCount: safeArray(caseOut.usedFields).length,
    droppedFieldCount: safeArray(caseOut.droppedFields).length,
  });

  const caseRows = uniqueBy(caseOut.rows, (row) => extractParticipantId(row));
  const caseByPatId = new Map(caseRows.map((row) => [extractParticipantId(row), row]));

  const followUpFetchStart = Date.now();
  const followUpOut =
    sourceIndex === "follow_up"
      ? {
          rows: sourceRows,
          totalCount: sourceOut.totalCount,
          usedFields: sourceOut.usedFields,
          droppedFields: sourceOut.droppedFields,
        }
      : sourceIndex === "aliquot"
        ? await fetchByIdChunks({
            guppyUrl,
            headers: guppyHeaders,
            index: "follow_up",
            idField: "follow_up_id",
            ids: linkedFollowUpIdsFromAliquots,
            fields: BASELINE_CLINICAL_FOLLOW_UP_FIELDS,
            timings: ctx?.timings,
            timingLabel: "buildMeta.fetch.baseline.followUp.chunk",
          })
      : sourceIndex === "molecular_test"
        ? await fetchByIdChunks({
            guppyUrl,
            headers: guppyHeaders,
            index: "follow_up",
            idField: "follow_up_id",
            ids: linkedFollowUpIdsFromLabResults,
            fields: BASELINE_CLINICAL_FOLLOW_UP_FIELDS,
            timings: ctx?.timings,
            timingLabel: "buildMeta.fetch.baseline.followUp.chunk",
          })
      : await fetchByIdChunks({
          guppyUrl,
          headers: guppyHeaders,
          index: "follow_up",
          idField: "pat_id",
          ids: participantIds,
          fields: BASELINE_CLINICAL_FOLLOW_UP_FIELDS,
          timings: ctx?.timings,
          timingLabel: "buildMeta.fetch.baseline.followUp.chunk",
        });
  recordTiming(ctx, "buildMeta.fetch.baseline.followUp.total", followUpFetchStart, {
    index: "follow_up",
    rows: safeArray(followUpOut.rows).length,
    totalCount: Number(followUpOut.totalCount || 0),
    fieldCount: safeArray(followUpOut.usedFields).length,
    droppedFieldCount: safeArray(followUpOut.droppedFields).length,
  });

  const followUpTransformStart = Date.now();
  const allFollowUps = uniqueBy(followUpOut.rows, (row) => {
    const patId = extractParticipantId(row);
    return `${patId}::${String(row?.follow_up_id || "").trim()}`;
  }).sort((a, b) => {
    const aVisit = toFiniteNumber(a?.visit_day);
    const bVisit = toFiniteNumber(b?.visit_day);
    const aKey = Number.isFinite(aVisit) ? aVisit : Number.POSITIVE_INFINITY;
    const bKey = Number.isFinite(bVisit) ? bVisit : Number.POSITIVE_INFINITY;
    if (aKey !== bKey) return aKey - bKey;

    const aPat = extractParticipantId(a);
    const bPat = extractParticipantId(b);
    if (aPat !== bPat) return aPat.localeCompare(bPat);

    return String(a?.follow_up_id || "").localeCompare(String(b?.follow_up_id || ""));
  });
  const allFollowUpIds = uniqueNonEmpty(allFollowUps.map((row) => String(row?.follow_up_id || "").trim()));
  recordTiming(ctx, "buildMeta.transform.baseline.followUp", followUpTransformStart, {
    followUps: allFollowUps.length,
    followUpIds: allFollowUpIds.length,
  });

  const labFetchStart = Date.now();
  const labOut = await fetchByIdChunks({
    guppyUrl,
    headers: guppyHeaders,
    index: "molecular_test",
    idField: "follow_up_id",
    ids: allFollowUpIds,
    fields: BASELINE_CLINICAL_LAB_FIELDS,
    timings: ctx?.timings,
    timingLabel: "buildMeta.fetch.baseline.lab.chunk",
  });
  recordTiming(ctx, "buildMeta.fetch.baseline.lab.total", labFetchStart, {
    index: "molecular_test",
    rows: safeArray(labOut.rows).length,
    totalCount: Number(labOut.totalCount || 0),
    fieldCount: safeArray(labOut.usedFields).length,
    droppedFieldCount: safeArray(labOut.droppedFields).length,
  });

  const finalTransformStart = Date.now();
  const labsByFollowUpId = pivotLabRows(labOut.rows);
  const participantLevelData = caseRows.map((caseRow) => ({
    pat_id: extractParticipantId(caseRow) || null,
    project_id: caseRow.project_id ?? null,
    cohort: caseRow.cohort ?? caseRow.case_group ?? null,
    study_site: caseRow.study_site ?? null,
    study_name: caseRow.study_name ?? null,
    age_at_index: toFiniteNumber(caseRow.age_at_index),
    gender: caseRow.gender ?? null,
    race: caseRow.race ?? null,
    ethnicity: caseRow.ethnicity ?? null,
    drinking_frequency: caseRow.drinking_frequency ?? null,
    drinks_per_day: toFiniteNumber(caseRow.drinks_per_day),
    actarm: caseRow.actarm ?? caseRow.case_arm ?? null,
    case_arm: caseRow.case_arm ?? caseRow.actarm ?? null,
    aki_status: caseRow.aki_status ?? null,
    days_to_aki: toFiniteNumber(caseRow.days_to_aki),
    days_90_aki: toFiniteNumber(caseRow.days_90_aki),
    days_180_aki: toFiniteNumber(caseRow.days_180_aki),
    vital_status: caseRow.vital_status ?? null,
    days_to_death: toFiniteNumber(caseRow.days_to_death),
    days_90_survival: toFiniteNumber(caseRow.days_90_survival),
    days_180_survival: toFiniteNumber(caseRow.days_180_survival),
  }));

  const fetchedData = allFollowUps.map((followUpRow) => {
    const patId = extractParticipantId(followUpRow);
    const caseRow = caseByPatId.get(patId) || {};
    const labRow = labsByFollowUpId.get(String(followUpRow?.follow_up_id || "").trim()) || {};

    const merged = {
      pat_id: patId,
      project_id: caseRow.project_id ?? followUpRow.project_id ?? labRow.project_id ?? null,
      cohort: caseRow.cohort ?? followUpRow.cohort ?? null,
      study_site: caseRow.study_site ?? followUpRow.study_site ?? null,
      study_name: caseRow.study_name ?? followUpRow.study_name ?? null,
      actarm: caseRow.actarm ?? followUpRow.case_arm ?? null,
      case_arm: followUpRow.case_arm ?? caseRow.actarm ?? null,
      aki_status: caseRow.aki_status ?? followUpRow.aki_status ?? null,
      days_to_aki: toFiniteNumber(caseRow.days_to_aki),
      days_90_aki: toFiniteNumber(caseRow.days_90_aki),
      days_180_aki: toFiniteNumber(caseRow.days_180_aki),
      vital_status: caseRow.vital_status ?? null,
      days_to_death: toFiniteNumber(caseRow.days_to_death),
      days_90_survival: toFiniteNumber(caseRow.days_90_survival),
      days_180_survival: toFiniteNumber(caseRow.days_180_survival),
      age_at_index: toFiniteNumber(caseRow.age_at_index),
      gender: caseRow.gender ?? followUpRow.gender ?? null,
      race: caseRow.race ?? followUpRow.race ?? null,
      ethnicity: caseRow.ethnicity ?? followUpRow.ethnicity ?? null,
      drinking_frequency: caseRow.drinking_frequency ?? null,
      drinks_per_day: toFiniteNumber(caseRow.drinks_per_day),
      follow_up_id: followUpRow.follow_up_id ?? null,
      visit_day: toFiniteNumber(followUpRow.visit_day),
      bmi: toFiniteNumber(followUpRow.bmi),
      tlfb_number_drinks: toFiniteNumber(followUpRow.tlfb_number_drinks),
      tlfb_drinking_days: toFiniteNumber(followUpRow.tlfb_drinking_days),
      meld_score: toFiniteNumber(followUpRow.meld_score),
      child_pugh_score: toFiniteNumber(followUpRow.child_pugh_score),
      maddreys_score: toFiniteNumber(followUpRow.maddreys_score),
      alcohol_use_baseline: null,
      estimated_gfr_mdrd: toFiniteNumber(labRow.estimated_gfr_mdrd),
      albumin: toFiniteNumber(labRow.albumin),
      total_bilirubin: toFiniteNumber(labRow.total_bilirubin),
      direct_bilirubin: toFiniteNumber(labRow.direct_bilirubin),
      creatinine: toFiniteNumber(labRow.creatinine),
      alt: toFiniteNumber(labRow.alt),
      ast: toFiniteNumber(labRow.ast),
      alkaline_phosphatase: toFiniteNumber(labRow.alkaline_phosphatase),
      total_protein: toFiniteNumber(labRow.total_protein),
      hemoglobin: toFiniteNumber(labRow.hemoglobin),
      total_wbc: toFiniteNumber(labRow.total_wbc),
      platelet_count: toFiniteNumber(labRow.platelet_count),
      mcv: toFiniteNumber(labRow.mcv),
      inr: toFiniteNumber(labRow.inr),
      pt_seconds: toFiniteNumber(labRow.pt_seconds),
    };

    merged.alcohol_use_baseline = inferAlcoholUseBaseline(merged);
    return merged;
  });

  const hasAnyLabDerivedData = BASELINE_CLINICAL_LAB_DERIVED_FIELDS.some((field) =>
    fetchedData.some((row) => row[field] != null)
  );
  const unavailableFields = [
    ...new Set([
      ...BASELINE_CLINICAL_UNAVAILABLE_FIELDS,
      ...(!hasAnyLabDerivedData ? BASELINE_CLINICAL_LAB_DERIVED_FIELDS : []),
    ]),
  ];

  const fieldAvailability = BASELINE_CLINICAL_EXPECTED_FIELDS
    .filter((field) => !unavailableFields.includes(field))
    .map((field) => {
      const availableCount = fetchedData.reduce((acc, row) => acc + (row[field] != null ? 1 : 0), 0);
      return {
        field,
        availableCount,
        missingCount: fetchedData.length - availableCount,
        availablePercent: fetchedData.length > 0 ? Number(((100 * availableCount) / fetchedData.length).toFixed(1)) : 0,
      };
    });
  recordTiming(ctx, "buildMeta.transform.baseline.final", finalTransformStart, {
    participantRows: participantLevelData.length,
    reportRows: fetchedData.length,
    fieldAvailabilityRows: fieldAvailability.length,
  });

  return withRequestedBy({
    generated_at: nowIso,
    kernel: ctx?.kernel || "UNKNOWN",
    template: ctx?.template || "baseline_clinical_summary_report",
    reportView: ctx?.reportView || sourceIndex,
    filters: {
      sourceIndex,
      sourceFilters,
    },
    sourceSelectedCount:
      sourceIndex === "aliquot"
        ? selectedAliquotIds.length
        : sourceIndex === "molecular_test"
          ? sourceRows.length
        : sourceIndex === "follow_up"
          ? sourceRows.length
          : participantIds.length,
    sourceUnit:
      sourceIndex === "aliquot"
        ? "biospecimens"
        : sourceIndex === "molecular_test"
          ? "lab results"
        : sourceIndex === "follow_up"
          ? "follow-up rows"
          : "participants",
    sourceTotalMatchCount: sourceOut.totalCount ?? sourceRows.length,
    sourceFetchedRowCount: sourceRows.length,
    sourceWasTruncated: (sourceOut.totalCount ?? sourceRows.length) > sourceRows.length,
    participantCount: participantIds.length,
    followUpCount: allFollowUpIds.length,
    fetchedCount: fetchedData.length,
    fetchedData,
    participantLevelData,
    biospecimenSummary,
    labResultSummary,
    fieldAvailability,
    unavailableFields,
    __debug: {
      guppyUrl,
      reportView: ctx?.reportView || sourceIndex,
      sourceIndex,
      sourceFieldsRequested: sourceFields,
      sourceFieldsUsed: sourceOut.usedFields || [],
      sourceDroppedFields: sourceOut.droppedFields || [],
      caseFieldsUsed: caseOut.usedFields || [],
      caseDroppedFields: caseOut.droppedFields || [],
      followUpFieldsUsed: followUpOut.usedFields || [],
      followUpDroppedFields: followUpOut.droppedFields || [],
      labFieldsUsed: labOut.usedFields || [],
      labDroppedFields: labOut.droppedFields || [],
      visitMode:
        sourceIndex === "follow_up"
          ? "selected follow-up rows only"
          : sourceIndex === "aliquot"
            ? "linked follow-up rows from selected biospecimens only"
            : sourceIndex === "molecular_test"
              ? "linked follow-up rows from selected lab results only"
            : "all linked follow-up rows retained",
      labTestsSupported: Object.keys(BASELINE_CLINICAL_LAB_TEST_ALIASES),
    },
  }, ctx);
}

export async function buildReportMeta(template, ctx) {
  const key = templateKey(template);

  if (key === "baseline_clinical_summary_report") {
    return await buildBaselineClinicalSummaryMeta({ ...ctx, template: key });
  }

  if (key === "test_report") {
    return await buildTestReportMeta({ ...ctx, template: key });
  }

  if (key === "demo_age_meld_report") {
    return buildDemoAgeMeldMeta({ ...ctx, template: key });
  }

  if (key === "basic_report") {
    return buildBasicReportMeta({ ...ctx, template: key });
  }

  // Fallback for other templates: use session.fetchedData if present (backward compat)
  const session = ctx?.session || {};
  const fetchedData = safeArray(session.fetchedData);

  return withRequestedBy({
    generated_at: new Date().toISOString(),
    kernel: ctx?.kernel || session.kernel || "UNKNOWN",
    template: key,
    fetchedCount: fetchedData.length,
    filters: session.filters || {},
    fetchedData,
  }, ctx);
}
