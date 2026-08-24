import { AsyncLocalStorage } from "async_hooks";
import log from "loglevel";

const requestContextStorage = new AsyncLocalStorage();

function serializeContextValue(value) {
    if (value == null || value === "") return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function truncateValue(value, maxLen = 600) {
    if (!value || value.length <= maxLen) return value;
    return `${value.slice(0, maxLen)}...`;
}

function formatContext() {
    const ctx = requestContextStorage.getStore();
    const parts = [];
    parts.push(`user=${ctx?.username || "anonymous"}`);
    parts.push(`method=${ctx?.method || "-"}`);
    parts.push(`url=${ctx?.url || "-"}`);
    parts.push(`filters=${truncateValue(serializeContextValue(ctx?.filters ?? "{}"))}`);
    return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
}

const originalFactory = log.methodFactory;
log.methodFactory = (methodName, logLevel, loggerName) => {
    const rawMethod = originalFactory(methodName, logLevel, loggerName);

    return (message, ...args) => {
        const timeStr = (new Date()).toISOString();
        const combinedMsg = args.reduce((acc, cur) => {
        if (typeof cur === "string") {
            return `${acc} ${cur}`;
        }
        return `${acc} ${JSON.stringify(cur, null, 4)}`;
        }, message);
        rawMethod(`[${timeStr}] ${methodName.toUpperCase()}:${formatContext()} ${combinedMsg}`);
    };
};

const numLevels = {
    0: 'TRACE',
    1: 'DEBUG',
    2: 'INFO',
    3: 'WARN',
    4: 'ERROR',
    5: 'SILENT',
};
log.levelEnums = {
    TRACE: 0,
    DEBUG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4,
    SILENT: 5,
};

log.setLevel('INFO');
log.setLogLevel = (level) => {
    if (!Object.keys(numLevels).includes(level) && !Object.keys(log.levelEnums).includes(level)) {
        throw new Error(`Invalid log level ${level}`);
    }
    log.setLevel(level);
    log.info("log level set to", numLevels[log.getLevel()]);
};

log.rawOutput = (level, msg) => {
    let parsedLevel = level;
    if (typeof level === "string") {
        if (!Object.keys(log.levelEnums).includes(level)) {
            throw new Error(`Invalid log level ${level}`);
        }
        parsedLevel = log.levelEnums[level];
    }
    if (parsedLevel >= log.getLevel()) {
        console.log(msg); // eslint-disable-line no-console
    }
};

log.withRequestContext = (ctx, fn) => requestContextStorage.run({ ...(ctx || {}) }, fn);
log.updateRequestContext = (patch) => {
    const ctx = requestContextStorage.getStore();
    if (!ctx || !patch) return;
    Object.assign(ctx, patch);
};
log.getRequestContext = () => requestContextStorage.getStore() || null;

export default log;
