/**
 * Mock SignPath REST service used by scripts/test-sign-flow.ps1.
 *
 * Implements the three endpoints scripts/sign.ps1 talks to:
 *   POST /Api/v1/{org}/SigningRequests/SubmitWithArtifact   -> 201 + Location
 *   GET  /Api/v1/{org}/SigningRequests/{id}                 -> status document
 *   GET  /Api/v1/{org}/SigningRequests/{id}/SignedArtifact  -> signed bytes
 *
 * The "signed" artifact is the uploaded bytes with a MARKER-SIGNED suffix, so
 * the test can prove the download replaced the original file.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 8799)
const ORG = 'org-test'
const SIGNED_MARKER = 'SIGNED-BY-MOCK'
const requests = []

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    requests.push({ method: req.method, path: url.pathname, bytes: body.length })
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const submit = new RegExp(`^/Api/v1/${ORG}/SigningRequests/SubmitWithArtifact$`)
    if (req.method === 'POST' && submit.test(url.pathname)) {
      const id = '11111111-2222-3333-4444-555555555555'
      uploaded.set(id, body)
      res.writeHead(201, { Location: `/Api/v1/${ORG}/SigningRequests/${id}` })
      res.end('')
      return
    }
    const status = new RegExp(`^/Api/v1/${ORG}/SigningRequests/([0-9a-f-]{36})$`)
    if (req.method === 'GET' && status.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'Completed',
          isFinalStatus: true,
          workflowStatus: 'Completed',
          signingRequestId: url.pathname.split('/').pop(),
        }),
      )
      return
    }
    const signed = new RegExp(`^/Api/v1/${ORG}/SigningRequests/([0-9a-f-]{36})/SignedArtifact$`)
    if (req.method === 'GET' && signed.test(url.pathname)) {
      const id = url.pathname.split('/').at(-2)
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(
        Buffer.concat([uploaded.get(id) ?? Buffer.alloc(0), Buffer.from(`\n${SIGNED_MARKER}`)]),
      )
      return
    }
    if (url.pathname === '/__requests') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(requests))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
})

const uploaded = new Map()

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`mock-signpath listening on ${PORT}\n`)
})
