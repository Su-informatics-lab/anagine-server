import express from "express";
import jwt from "jsonwebtoken";

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

function writeLoginEvent(log, payload, level = "INFO") {
  const timestamp = new Date().toISOString();
  log.rawOutput(level, `[${timestamp}] LOGIN: ${JSON.stringify({
    "@timestamp": timestamp,
    event_type: "login",
    service: "anagine",
    environment: serviceEnvironment(),
    ...payload,
  })}`);
}

export function createCheckAuthMiddleware({ log }) {
  return function checkAuth(req, res, next) {
    const authHeader = req.headers["authorization"];
    if (!authHeader) return res.status(401).json({ error: "Missing token" });

    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.decode(token);

      if (decoded?.context?.user?.name) {
        req.user = decoded.context.user.name;
        req.token = token;
      } else if (decoded?.user) {
        req.user = decoded.user;
        req.token = token;
      } else {
        return res.status(401).json({ error: "Invalid token format" });
      }

      if (typeof log.updateRequestContext === "function") {
        log.updateRequestContext({ username: req.user });
      }

      next();
    } catch (e) {
      log.error("[checkAuth] Token decode error:", e);
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}

export default function createAuthRouter({ userSessions, log }) {
  const router = express.Router();

  router.post("/login", async (req, res) => {
    const token = req.cookies.access_token;

    if (!token) {
      writeLoginEvent(log, {
        outcome: "failure",
        user: "anonymous",
        method: req.method,
        url: req.originalUrl || req.url,
        status: 401,
        error_type: "missing_cookie",
        error_message: "Please log in to Gen3 first",
        vis_event_type: "login",
        vis_outcome: "failure",
      });
      return res.status(401).json({
        error: "Please log in to Gen3 first",
        hint: "Not authenticated. Make sure you are logged in to the Gen3 portal.",
      });
    }

    try {
      const decoded = jwt.decode(token, { complete: true });

      if (!decoded || !decoded.payload) {
        writeLoginEvent(log, {
          outcome: "failure",
          user: "anonymous",
          method: req.method,
          url: req.originalUrl || req.url,
          status: 401,
          error_type: "invalid_token_format",
          error_message: "Invalid token format",
          vis_event_type: "login",
          vis_outcome: "failure",
        });
        return res.status(401).json({ error: "Invalid token format" });
      }

      const payload = decoded.payload;
      const username = payload?.context?.user?.name || payload?.sub;

      if (!username) {
        writeLoginEvent(log, {
          outcome: "failure",
          user: "anonymous",
          method: req.method,
          url: req.originalUrl || req.url,
          status: 401,
          error_type: "missing_user",
          error_message: "Invalid token: missing user information",
          vis_event_type: "login",
          vis_outcome: "failure",
        });
        return res.status(401).json({ error: "Invalid token: missing user information" });
      }

      if (payload.exp) {
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp < now) {
          const expiredTime = new Date(payload.exp * 1000).toISOString();
          writeLoginEvent(log, {
            outcome: "failure",
            user: username,
            method: req.method,
            url: req.originalUrl || req.url,
            status: 401,
            token_expires: expiredTime,
            error_type: "token_expired",
            error_message: "Token expired",
            vis_event_type: "login",
            vis_outcome: "failure",
          });
          return res.status(401).json({ error: "Token expired", expired_at: expiredTime });
        }
      }

      req.user = username;
      if (typeof log.updateRequestContext === "function") {
        log.updateRequestContext({ username });
      }

      userSessions[username] = userSessions[username] || {};
      if (!userSessions[username].llmHistory) {
        userSessions[username].llmHistory = [];
      }

      const isAdmin = payload?.context?.user?.is_admin || false;
      writeLoginEvent(log, {
        outcome: "success",
        user: username,
        method: req.method,
        url: req.originalUrl || req.url,
        status: 200,
        is_admin: isAdmin,
        token_expires: payload.exp ? new Date(payload.exp * 1000).toISOString() : "unknown",
        vis_event_type: "login",
        vis_outcome: "success",
      });

      res.json({ token, username, is_admin: isAdmin });
    } catch (e) {
      writeLoginEvent(log, {
        outcome: "failure",
        user: req.user || "anonymous",
        method: req.method,
        url: req.originalUrl || req.url,
        status: 401,
        error_type: "invalid_token",
        error_message: "Invalid token",
        vis_event_type: "login",
        vis_outcome: "failure",
      });
      res.status(401).json({ error: "Invalid token" });
    }
  });

  return router;
}
