/**
 * Shared Guppy query logic for /anagine/query and Report.
 * Both use this to fetch data from Guppy (full or paginated).
 */
import { getGQLFilter } from "./filters.js";

function rawDataQueryStrForEachField(field) {
  const parts = String(field).split(".");
  const head = parts.shift();
  if (parts.length === 0) return head;
  return `${head} {\n    ${rawDataQueryStrForEachField(parts.join("."))}\n  }`;
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
  if (json.errors && (!json.data || Object.keys(json.data).length === 0)) {
    throw new Error(`Guppy error: ${JSON.stringify(json.errors).slice(0, 800)}`);
  }
  return json;
}

function buildAggregationQuery(index) {
  return `
    query($filter: JSON) {
      agg: _aggregation {
        ${index}(filter: $filter, accessibility: all) { _totalCount }
      }
    }
  `;
}

function isFlatFieldName(field) {
  return typeof field === "string" && field.trim() !== "" && !field.includes(".") && !field.includes("{") && !field.includes("}");
}

function canUseDownloadEndpoint(index, fields = []) {
  const eligible = new Set(["aliquot", "molecular_test"]);
  return eligible.has(String(index || "").trim()) && Array.isArray(fields) && fields.length > 0 && fields.every(isFlatFieldName);
}

function deriveDownloadUrl(guppyUrl) {
  const url = String(guppyUrl || "");
  if (url.endsWith("/graphql")) return `${url.slice(0, -"/graphql".length)}/download`;
  return `${url.replace(/\/$/, "")}/download`;
}

async function guppyDownload(url, payload, headers = {}) {
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
    throw new Error(`Guppy download non-JSON response (${resp.status}): ${text.slice(0, 300)}`);
  }
  if (!resp.ok) {
    throw new Error(`Guppy download error (${resp.status}): ${JSON.stringify(json).slice(0, 800)}`);
  }
  if (!Array.isArray(json)) {
    throw new Error(`Guppy download returned unexpected payload: ${JSON.stringify(json).slice(0, 800)}`);
  }
  return json;
}

export const PAGE_SIZE = 2000;
export const HARD_LIMIT = 20000;
export const DOWNLOAD_THRESHOLD = 10000;

/**
 * Fetch all rows from Guppy with given params.
 * Same logic used by /anagine/query (fetchAll) and Report.
 *
 * @param {Object} opts
 * @param {string} opts.guppyUrl - Guppy GraphQL URL
 * @param {Object} opts.headers - Request headers (e.g. Authorization)
 * @param {string} opts.index - Type name (case, subject, follow_up)
 * @param {Object} opts.filters - Raw filters (Explorer format)
 * @param {string[]} opts.fields - Field names
 * @returns {Promise<{ rows: any[], totalCount: number }>}
 */
export async function fetchAllFromGuppy({ guppyUrl, headers = {}, index, filters = {}, fields = [] }) {
  const gqlFilter = Object.keys(filters || {}).length === 0 ? {} : toGuppyFilter(filters);
  const processedFields =
    fields.length > 0 ? fields.map((f) => rawDataQueryStrForEachField(f)) : ["submitter_id"];

  const aggQuery = buildAggregationQuery(index);
  const aggOut = await guppyPost(
    guppyUrl,
    { query: aggQuery, variables: { filter: gqlFilter || {} } },
    headers
  );
  const totalCount = aggOut?.data?.agg?.[index]?._totalCount ?? 0;

  if (totalCount > DOWNLOAD_THRESHOLD && canUseDownloadEndpoint(index, fields)) {
    const rows = await guppyDownload(
      deriveDownloadUrl(guppyUrl),
      {
        type: index,
        fields,
        filter: gqlFilter || {},
        accessibility: "all",
      },
      headers
    );
    return { rows, totalCount };
  }

  const query = `
    query($filter: JSON, $first: Int, $offset: Int) {
      rows: ${index}(filter: $filter, first: $first, offset: $offset, accessibility: all) {
        ${processedFields.join("\n        ")}
      }
    }
  `;

  const rows = [];
  let offset = 0;

  while (true) {
    const first = Math.min(PAGE_SIZE, HARD_LIMIT - rows.length);
    if (first <= 0) break;

    const out = await guppyPost(
      guppyUrl,
      { query, variables: { filter: gqlFilter || {}, first, offset } },
      headers
    );

    const chunk = Array.isArray(out?.data?.rows) ? out.data.rows : [];

    rows.push(...chunk);
    offset += chunk.length;

    if (chunk.length === 0) break;
    if (rows.length >= totalCount) break;
    if (rows.length >= HARD_LIMIT) break;
  }

  return { rows, totalCount: totalCount ?? rows.length };
}

function toGuppyFilter(rawFilter) {
  if (!rawFilter || Object.keys(rawFilter).length === 0) return {};
  const isExplorerFormat = (obj) =>
    obj && typeof obj === "object" && Object.values(obj).some((v) => v && typeof v === "object" && ("selectedValues" in v || "lowerBound" in v));
  return isExplorerFormat(rawFilter) ? getGQLFilter(rawFilter) : rawFilter;
}
