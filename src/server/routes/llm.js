import express from "express";
import fetch from "node-fetch";
import https from "https";

export default function createLlmRouter({ checkAuth, userSessions, log }) {
  const router = express.Router();

  const OPENAI_BASE_URL =
    process.env.ANAGINE_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || process.env.MSU_API_URL || "";
  const OPENAI_MODEL =
    process.env.ANAGINE_OPENAI_MODEL || process.env.OPENAI_MODEL || process.env.MSU_MODEL || "gpt-oss20b";
  const OPENAI_API_KEY =
    process.env.ANAGINE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || process.env.MSU_API_KEY || "";
  const OPENAI_INSECURE_TLS =
    ["1", "true", "yes", "on"].includes(
      String(process.env.ANAGINE_OPENAI_INSECURE_TLS || process.env.OPENAI_INSECURE_TLS || "").toLowerCase()
    );
  const openaiAgent = OPENAI_INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined;

  const OLLAMA_HOST =
    process.env.ANAGINE_OLLAMA_HOST || process.env.OLLAMA_HOST || "http://ollama:11434";
  const OLLAMA_MODEL =
    process.env.ANAGINE_OLLAMA_MODEL || process.env.OLLAMA_MODEL || "llama3.2:1b";

  function getBackendLabel(provider) {
    if (provider === "openai") {
      if ((OPENAI_BASE_URL || "").includes("18.189.29.178")) {
        return "ARDAC AWS Ollama";
      }
      return "OpenAI-compatible LLM service";
    }

    if (provider === "ollama") {
      return "Local Ollama";
    }

    return "LLM service";
  }

  function extractModelName(raw, provider) {
    return raw?.model || raw?.message?.model || (provider === "ollama" ? OLLAMA_MODEL : OPENAI_MODEL);
  }

  function formatAssistantReply({ text, raw, provider, includeIntro = false }) {
    if (!includeIntro) return text;

    const backend = getBackendLabel(provider);
    const intro =
      `Hello! I am your AI assistant here.\n` +
      `Backend: ${backend}\n`;

    return `${intro}\n${text}`;
  }

  async function chatWithLLM(messages) {
    const baseUrl = (OPENAI_BASE_URL || "").replace(/\/+$/, "").replace(/\/v1\/?$/, "");
    const chatUrl = baseUrl ? `${baseUrl}/v1/chat/completions` : null;

    if (chatUrl) {
      try {
        const headers = { "Content-Type": "application/json" };
        if (OPENAI_API_KEY) headers.Authorization = `Bearer ${OPENAI_API_KEY}`;

        const r = await fetch(chatUrl, {
          method: "POST",
          agent: openaiAgent,
          headers,
          body: JSON.stringify({ model: OPENAI_MODEL, messages, stream: false }),
        });

        if (r.ok) {
          const j = await r.json();
          const text = j.choices?.[0]?.message?.content ?? "";
          if (text) {
            log.info("[LLM] used OpenAI-compatible API");
            return { text, raw: j, provider: "openai" };
          }
        }

        const errText = await r.text().catch(() => "");
        log.warn(`[LLM] OpenAI-compatible request failed (${r.status}): ${errText.slice(0, 200)}`);
      } catch (e) {
        log.warn("[LLM] OpenAI-compatible request error:", e.message);
      }
    }

    try {
      const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false }),
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`Ollama ${r.status}: ${t}`);
      }

      const j = await r.json();
      const text = j.message?.content ?? j.response ?? "";
      log.info("[LLM] used Ollama (fallback)");
      return { text, raw: j, provider: "ollama" };
    } catch (e) {
      log.error("[LLM] Ollama fallback failed:", e.message);
      throw e;
    }
  }

  router.post("/llm/public", async (req, res) => {
    const { prompt = "", history = [] } = req.body || {};
    const messages = [...history, { role: "user", content: prompt }];
    const isFirstAssistantTurn = !Array.isArray(history) || history.length === 0;
    try {
      const { text, raw, provider } = await chatWithLLM(messages);
      res.json({
        text: formatAssistantReply({ text, raw, provider, includeIntro: isFirstAssistantTurn }),
        raw,
        provider,
      });
    } catch (e) {
      res.status(502).json({ error: "LLM error", detail: String(e) });
    }
  });

  router.post("/llm", checkAuth, async (req, res) => {
    const username = req.user;
    const { prompt = "" } = req.body || {};

    userSessions[username] = userSessions[username] || {};
    const hist = (userSessions[username].llmHistory ||= []);
    const isFirstAssistantTurn = hist.length === 0;

    hist.push({ role: "user", content: prompt });
    const maxMsg = 20;
    if (hist.length > maxMsg) hist.splice(0, hist.length - maxMsg);

    try {
      const { text, raw, provider } = await chatWithLLM(hist);
      const finalText = formatAssistantReply({ text, raw, provider, includeIntro: isFirstAssistantTurn });
      hist.push({ role: "assistant", content: finalText });
      res.json({ text: finalText, raw, provider });
    } catch (e) {
      res.status(502).json({ error: "LLM error", detail: String(e) });
    }
  });

  router.post("/clear-history", checkAuth, (req, res) => {
    const username = req.user;
    if (userSessions[username]) userSessions[username].llmHistory = [];
    res.json({ status: "ok", cleared: true });
  });

  router.post("/reset-session", checkAuth, (req, res) => {
    const username = req.user;
    userSessions[username] = {};
    res.json({ status: "ok", reset: true });
  });

  return router;
}
