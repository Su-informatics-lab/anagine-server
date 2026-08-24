import fetch from 'node-fetch';
import https from 'https';
import config from '../config.js'; // Ensure relative path is correct

const ensureHttp = (url) =>
   url && !/^https?:\/\//i.test(url) ? `http://${url}` : url;
const OPENAI_BASE_URL = ensureHttp(
   process.env.ANAGINE_OPENAI_BASE_URL ||
   process.env.OPENAI_BASE_URL ||
   process.env.MSU_API_URL ||
   (config?.openaiConfig?.host ?? '')
 );
const OPENAI_MODEL_DEFAULT =
    process.env.ANAGINE_OPENAI_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.MSU_MODEL ||
    (config?.openaiConfig?.model ?? 'gpt-oss20b');
const OPENAI_API_KEY =
    process.env.ANAGINE_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.MSU_API_KEY ||
    (config?.openaiConfig?.apiKey ?? '');
const OPENAI_INSECURE_TLS =
    ['1', 'true', 'yes', 'on'].includes(
      String(
        process.env.ANAGINE_OPENAI_INSECURE_TLS ||
        process.env.OPENAI_INSECURE_TLS ||
        config?.openaiConfig?.insecureTls ||
        ''
      ).toLowerCase()
    );
const OLLAMA_HOST = ensureHttp(
   process.env.ANAGINE_OLLAMA_HOST ||
   process.env.OLLAMA_HOST ||
   (config?.ollamaConfig?.host ?? 'http://127.0.0.1:11434')
 );
const OLLAMA_MODEL_DEFAULT =
    process.env.ANAGINE_OLLAMA_MODEL || (config?.ollamaConfig?.model ?? 'llama3.2:1b');
const OPENAI_CHAT_URL = OPENAI_BASE_URL
  ? `${OPENAI_BASE_URL.replace(/\/+$/, '').replace(/\/v1\/?$/, '')}/v1/chat/completions`
  : '';
const OPENAI_AGENT = OPENAI_INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined;

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    agent: url.startsWith('https://') && url.includes('/v1/') ? OPENAI_AGENT : undefined,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

function getOpenAIHeaders() {
  return OPENAI_API_KEY ? { Authorization: `Bearer ${OPENAI_API_KEY}` } : {};
}

async function* singleChunkStream(text) {
  yield { response: text, done: true };
}

async function chatViaOpenAI(model, messages, options = {}) {
  const data = await postJson(
    OPENAI_CHAT_URL,
    {
      model,
      messages,
      stream: false,
      ...options,
    },
    getOpenAIHeaders()
  );
  return {
    model,
    created_at: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: data.choices?.[0]?.message?.content ?? '',
    },
    provider: 'openai',
    raw: data,
  };
}

async function chatViaOllama(model, messages, stream = false, options = {}) {
  return postJson(`${OLLAMA_HOST}/api/chat`, {
    model,
    messages,
    stream,
    ...options,
  });
}

async function generateViaOllama(model, prompt, stream = false, options = {}) {
  return postJson(`${OLLAMA_HOST}/api/generate`, {
    model,
    prompt,
    stream,
    ...options,
  });
}

/**
 * Chat with a specified LLM model.
 * @param {string} model - Model name
 * @param {Array} messages - Array of { role, content } message objects
 * @param {boolean} [stream=false] - Whether to stream responses
 * @param {object} [options={}] - Additional options
 * @returns {Promise<object>}
 */
export async function chatWithModel(model = config.defaultLlmModel, messages, stream = false, options = {}) {
  try {
    if (OPENAI_CHAT_URL) {
      if (stream) {
        const chat = await chatViaOpenAI(model || OPENAI_MODEL_DEFAULT, messages, options);
        return singleChunkStream(chat.message?.content || '');
      }
      return await chatViaOpenAI(model || OPENAI_MODEL_DEFAULT, messages, options);
    }

    return await chatViaOllama(model, messages, stream, options);
  } catch (error) {
    console.error(`? Error chatting with model "${model}":`, error.message || error);
    throw error;
  }
}

/**
 * Generate text using a specified LLM model.
 * @param {string} model - Model name
 * @param {Array} messages - Array of { role, content } message objects
 * @param {boolean} [stream=false] - Whether to stream responses
 * @param {object} [options={}] - Additional options
 * @returns {Promise<object>}
 */
export async function generateText(
   model = config.defaultLlmModel,
   prompt,
   stream = false,
   options = {}
 ) {
   if (OPENAI_CHAT_URL) {
     const result = await chatViaOpenAI(
       model || OPENAI_MODEL_DEFAULT,
       [{ role: 'user', content: prompt }],
       options
     );
     const text = result.message?.content || '';
     if (stream) {
       return singleChunkStream(text);
     }
     return { response: text, provider: 'openai', raw: result.raw };
   }

   return generateViaOllama(model, prompt, stream, options);
 }

console.info(
  '[llm] primary =',
  OPENAI_CHAT_URL ? `${OPENAI_MODEL_DEFAULT} @ ${OPENAI_BASE_URL}` : 'none',
  OPENAI_INSECURE_TLS ? '(self-signed TLS allowed)' : '',
  '| backup =',
  `${OLLAMA_MODEL_DEFAULT} @ ${OLLAMA_HOST}`
);
