// src/server/routes/arboristProxy.js
import express from 'express'
import fetch from 'node-fetch' // Node <18 has no global fetch; this also works on Node 18+

const router = express.Router()

// Proxy all methods from /anagine/arborist/* to ${ANAGINE_ARBORIST_HOST}/*
router.all('/arborist/*', async (req, res) => {
  try {
    const base = process.env.ANAGINE_ARBORIST_HOST // e.g. https://hl.../arborist or http://arborist-service
    const suffix = req.params[0] || ''             // Remaining path captured by *
    const url = `${base}/${suffix}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`

    // Copy request headers and remove host/content-length
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => !['host','content-length'].includes(k.toLowerCase()))
    )

    // Body handling: no body for GET/HEAD; pass JSON through for other methods
    const body = ['GET','HEAD'].includes(req.method) ? undefined :
      req.is('application/json') ? JSON.stringify(req.body) : undefined

    const resp = await fetch(url, {
      method: req.method,
      headers,
      body
    })

    // Pass through response
    res.status(resp.status)
    if (resp.headers.get('content-type')) {
      res.set('Content-Type', resp.headers.get('content-type'))
    }
    const buf = await resp.arrayBuffer()
    res.send(Buffer.from(buf))
  } catch (err) {
    const code = err.cause?.code || err.code || 'UNKNOWN'
    res.status(502).json({ error: 'arborist proxy failed', code, detail: String(err) })
  }
})

export default router
