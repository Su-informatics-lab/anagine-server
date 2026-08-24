import fetch from "node-fetch";
import { getGQLFilter } from "../../utils/filters.js";
import {
  fetchAllFromGuppy,
  PAGE_SIZE as GUPPY_PAGE_SIZE,
  HARD_LIMIT as GUPPY_HARD_LIMIT,
} from "../../utils/guppyClient.js";

function rawDataQueryStrForEachField(field) {
  const splittedFieldArray = field.split(".");
  const splittedField = splittedFieldArray.shift();
  if (splittedFieldArray.length === 0) {
    return splittedField;
  }
  return `${splittedField} {\n    ${rawDataQueryStrForEachField(splittedFieldArray.join("."))}\n  }`;
}

function applyGuppyFilters(records, filters) {
  return records.filter((record) => {
    for (const [field, value] of Object.entries(filters)) {
      if (typeof value === "object" && value.selectedValues) {
        if (!value.selectedValues.includes(record[field])) return false;
      } else if (
        typeof value === "object" &&
        (value.lowerBound !== undefined || value.upperBound !== undefined)
      ) {
        const fieldValue = Number(record[field]);
        if (Number.isNaN(fieldValue)) return false;

        if (value.lowerBound !== undefined && fieldValue < value.lowerBound) return false;
        if (value.upperBound !== undefined && fieldValue > value.upperBound) return false;
      } else if (typeof value === "string" && value.startsWith(">=")) {
        const threshold = parseFloat(value.substring(2));
        if (Number.isNaN(threshold) || !(parseFloat(record[field]) >= threshold)) return false;
      } else if (typeof value === "string" && value.startsWith("<=")) {
        const threshold = parseFloat(value.substring(2));
        if (Number.isNaN(threshold) || !(parseFloat(record[field]) <= threshold)) return false;
      } else if (typeof value === "string" && value.startsWith(">")) {
        const threshold = parseFloat(value.substring(1));
        if (Number.isNaN(threshold) || !(parseFloat(record[field]) > threshold)) return false;
      } else if (typeof value === "string" && value.startsWith("<")) {
        const threshold = parseFloat(value.substring(1));
        if (Number.isNaN(threshold) || !(parseFloat(record[field]) < threshold)) return false;
      } else if (record[field] !== value) {
        return false;
      }
    }
    return true;
  });
}

async function queryFromMemory({ username, filters, fields, first, offset, userSessions, datasets, log }) {
  const startTime = Date.now();
  const session = userSessions[username] || {};
  const datasetName = session.dataset || "ARDaC-AlcHepNet";

  let records = datasets[datasetName] || [];
  const originalCount = records.length;
  log.info(`[queryFromMemory] Dataset: ${datasetName}, Original records: ${originalCount}`);

  if (filters && Object.keys(filters).length > 0) {
    const filterStartTime = Date.now();
    records = applyGuppyFilters(records, filters);
    const filterTime = Date.now() - filterStartTime;
    log.info(
      `[queryFromMemory] Filter applied in ${filterTime}ms: ${originalCount} -> ${records.length} records (${(
        (records.length / originalCount) *
        100
      ).toFixed(1)}% retained)`
    );
  }

  const totalCount = records.length;
  const paginatedRecords = records.slice(offset, offset + first);
  log.info(`[queryFromMemory] Pagination: offset=${offset}, first=${first}, returned=${paginatedRecords.length}`);

  let finalRecords = paginatedRecords;
  if (fields.length > 0) {
    finalRecords = paginatedRecords.map((record) => {
      const filtered = {};
      fields.forEach((field) => {
        if (record[field] !== undefined) filtered[field] = record[field];
      });
      return filtered;
    });
    log.info(`[queryFromMemory] Field filtering applied: ${fields.length} fields selected`);
  }

  const elapsedTime = Date.now() - startTime;
  log.info(`[queryFromMemory] Completed in ${elapsedTime}ms - Returned: ${finalRecords.length}/${totalCount} records`);

  return { data: finalRecords, totalCount };
}

async function queryFromGuppy({ index, filters, fields, first, offset, fetchAll = false, token, config, log }) {
  const startTime = Date.now();
  const guppyHost = (config?.guppyConfig?.host || "http://localhost:3010").replace(/\/+$/, "");
  const guppyUrl = guppyHost.includes("graphql") ? guppyHost : `${guppyHost}/graphql`;
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };

  log.info(`[queryFromGuppy] fetchAll=${fetchAll} index=${index} token=${token ? "present" : "missing"}`);

  if (fetchAll) {
    const { rows, totalCount } = await fetchAllFromGuppy({
      guppyUrl,
      headers,
      index,
      filters,
      fields: fields.length > 0 ? fields : ["submitter_id"],
    });
    const elapsed = Date.now() - startTime;
    log.info(`[queryFromGuppy] fetchAll completed in ${elapsed}ms - Returned: ${rows.length}/${totalCount} records`);
    return { data: rows, totalCount };
  }

  const gqlFilter = getGQLFilter(filters);
  const fieldsList = fields.length > 0 ? fields : ["submitter_id"];
  const processedFields = fieldsList.map((field) => rawDataQueryStrForEachField(field));

  const query = `
    query($first: Int, $offset: Int, $filters: JSON) {
      ${index}(filter: $filters, first: $first, offset: $offset, accessibility: all) {
        ${processedFields.join("\n        ")}
      }
      _aggregation {
        ${index}(filter: $filters, accessibility: all) {
          _totalCount
        }
      }
    }
  `;

  const response = await fetch(guppyUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query, variables: { first, offset, filters: gqlFilter } }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Guppy HTTP ${response.status}: ${text.slice(0, 300)}`);

  const result = JSON.parse(text);
  if (result.errors && (!result.data || Object.keys(result.data || {}).length === 0)) {
    throw new Error(`Guppy error: ${JSON.stringify(result.errors).slice(0, 500)}`);
  }

  const chunk = result.data?.[index] || [];
  const total = result.data?._aggregation?.[index]?._totalCount ?? chunk.length;
  const elapsed = Date.now() - startTime;
  log.info(`[queryFromGuppy] Completed in ${elapsed}ms - Returned: ${chunk.length}/${total} records`);
  return { data: chunk, totalCount: total };
}

export default function registerQueryFetchRoutes(router, { checkAuth, userSessions, datasets, log, config }) {
  router.post("/select-kernel", checkAuth, (req, res) => {
    const username = req.user;
    const { kernel } = req.body || {};
    const allowed = ["R", "PY"];
    if (!allowed.includes(kernel)) {
      return res.status(400).json({ error: "kernel must be 'R' or 'PY'" });
    }
    userSessions[username] = userSessions[username] || {};
    userSessions[username].kernel = kernel;
    res.json({ status: "ok", kernel });
  });

  router.post("/select-dataset", checkAuth, (req, res) => {
    const username = req.user;
    const { dataset } = req.body || {};
    if (!datasets[dataset]) return res.status(400).json({ error: "Dataset not found" });
    userSessions[username] = userSessions[username] || {};
    userSessions[username].dataset = dataset;
    res.json({ status: "ok", dataset });
  });

  router.post("/filter", checkAuth, (req, res) => {
    const startTime = Date.now();
    const username = req.user;
    const { filters } = req.body || {};

    log.info(`[FILTER] User: ${username}, Setting filters:`, JSON.stringify(filters, null, 2));

    userSessions[username] = userSessions[username] || {};
    userSessions[username].filters = filters ?? null;

    const elapsedTime = Date.now() - startTime;
    log.info(
      `[FILTER] Success - User: ${username}, Wall time: ${elapsedTime}ms, Filters set:`,
      JSON.stringify(filters, null, 2)
    );

    res.json({ status: "ok", filters: userSessions[username].filters });
  });

  router.post("/fetch", checkAuth, async (req, res) => {
    const startTime = Date.now();
    const username = req.user;
    const session = userSessions[username] || {};

    log.info(`[FETCH] User: ${username}, Dataset: ${session.dataset}`);

    if (!session.dataset) {
      log.warn(`[FETCH] Failed - User: ${username}, Error: No dataset selected`);
      return res.status(400).json({ error: "No dataset selected" });
    }

    let records = datasets[session.dataset] || [];
    const originalCount = records.length;
    const filters = session.filters;

    log.info(`[FETCH] Original dataset size: ${originalCount} records, Filters:`, JSON.stringify(filters, null, 2));

    if (filters && typeof filters === "object") {
      const filterStartTime = Date.now();
      records = records.filter((r) => {
        for (const [k, v] of Object.entries(filters)) {
          if (r[k] == null) return false;
          if (typeof v === "string" && v.startsWith(">")) {
            const thr = Number(v.slice(1));
            if (!(Number(r[k]) > thr)) return false;
          } else if (r[k] !== v) {
            return false;
          }
        }
        return true;
      });
      const filterTime = Date.now() - filterStartTime;
      log.info(
        `[FETCH] Filter applied in ${filterTime}ms: ${originalCount} -> ${records.length} records (${(
          (records.length / originalCount) *
          100
        ).toFixed(1)}% retained)`
      );
    }

    userSessions[username] = { ...session, fetchedData: records };

    const elapsedTime = Date.now() - startTime;
    log.info(`[FETCH] Success - User: ${username}, Total wall time: ${elapsedTime}ms, Result count: ${records.length}`);

    res.json({ count: records.length, sample: records.slice(0, 5) });
  });

  router.post("/query", checkAuth, async (req, res) => {
    const startTime = Date.now();
    try {
      const username = req.user;
      const {
        dataSource = "guppy",
        index = "subject",
        filters = {},
        fields = [],
        first = 100,
        offset = 0,
        fetchAll = true,
      } = req.body;

      log.info(`[QUERY] Started - User: ${username}, DataSource: ${dataSource}, Index: ${index}, fetchAll: ${fetchAll}`);
      log.info(`[QUERY] Request params - First: ${first}, Offset: ${offset}, Filters:`, JSON.stringify(filters, null, 2));

      userSessions[username] = userSessions[username] || {};
      userSessions[username].lastQueryFilters = filters;
      userSessions[username].lastQueryFields = Array.isArray(fields) ? fields : [];
      userSessions[username].lastQueryIndex = index;

      let results;
      const queryStartTime = Date.now();

      if (dataSource === "memory") {
        results = await queryFromMemory({
          username,
          filters,
          fields,
          first: fetchAll ? GUPPY_HARD_LIMIT : first,
          offset: fetchAll ? 0 : offset,
          userSessions,
          datasets,
          log,
        });
      } else if (dataSource === "guppy") {
        results = await queryFromGuppy({
          index,
          filters,
          fields,
          first: fetchAll ? GUPPY_PAGE_SIZE : first,
          offset: fetchAll ? 0 : offset,
          fetchAll,
          token: req.token,
          config,
          log,
        });
      } else {
        const elapsedTime = Date.now() - startTime;
        log.warn(`[QUERY] Failed - Wall time: ${elapsedTime}ms, Invalid dataSource: ${dataSource}`);
        return res.status(400).json({ error: 'Invalid dataSource. Must be "guppy" or "memory"' });
      }

      const queryTime = Date.now() - queryStartTime;
      const totalTime = Date.now() - startTime;

      log.info(`[QUERY] Success - User: ${username}, DataSource: ${dataSource}`);
      log.info(`[QUERY] Performance - Query time: ${queryTime}ms, Total wall time: ${totalTime}ms`);
      log.info(`[QUERY] Results - Returned: ${results.data.length} records, Total count: ${results.totalCount}`);

      res.json({
        success: true,
        data: results.data,
        totalCount: results.totalCount,
        source: dataSource,
        filters,
        performanceMetrics: {
          queryTimeMs: queryTime,
          totalTimeMs: totalTime,
        },
      });
    } catch (error) {
      const elapsedTime = Date.now() - startTime;
      log.error(`[QUERY] Failed - Wall time: ${elapsedTime}ms, Error: ${error.message}`);
      log.error("[QUERY] Error stack:", error.stack);
      res.status(500).json({ error: error.message });
    }
  });
}
