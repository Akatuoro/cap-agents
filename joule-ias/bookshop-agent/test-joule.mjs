import https from 'https'
import { readFileSync } from 'fs'

// Load .env
const env = Object.fromEntries(
  readFileSync('.env', 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('=').map((p, i) => i === 0 ? p : l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')))
)

const { JOULE_API_URL, JOULE_AUTH_URL, JOULE_CLIENT_ID, JOULE_CLIENT_SECRET, JOULE_USERNAME, JOULE_PASSWORD } = env

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = typeof body === 'string' ? body : JSON.stringify(body)
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }))
    })
    req.on('error', reject); req.write(data); req.end()
  })
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }))
    })
    req.on('error', reject); req.end()
  })
}

// Step 1: Get user token via ROPC
console.log('Getting user token...')
const userTokenRes = await post(
  `${JOULE_AUTH_URL}/oauth2/token`,
  new URLSearchParams({
    grant_type: 'password',
    token_format: 'jwt',
    username: JOULE_USERNAME,
    password: JOULE_PASSWORD,
  }).toString(),
  { Authorization: `Basic ${Buffer.from(`${JOULE_CLIENT_ID}:${JOULE_CLIENT_SECRET}`).toString('base64')}` }
)
if (userTokenRes.status !== 200) { console.error('User token failed:', userTokenRes.status, userTokenRes.body); process.exit(1) }
const { access_token: userToken } = JSON.parse(userTokenRes.body)
console.log('Got user token.')

// Step 2: Exchange for Joule API token
console.log('Exchanging for Joule API token...')
const jouleTokenRes = await post(
  `${JOULE_AUTH_URL}/oauth2/token`,
  new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: JOULE_CLIENT_ID,
    client_secret: JOULE_CLIENT_SECRET,
    assertion: userToken,
    resource: 'urn:sap:identity:application:provider:name:Cli2Joule',
  }).toString()
)
if (jouleTokenRes.status !== 200) { console.error('Joule token exchange failed:', jouleTokenRes.status, jouleTokenRes.body); process.exit(1) }
const { access_token } = JSON.parse(jouleTokenRes.body)
console.log('Got Joule API token.')

const ASSISTANT = 'sap_digital_assistant'
const WEBCLIENT = `${JOULE_API_URL}/api/protected/connect/clientapi/webclient/v1/${ASSISTANT}`
const auth = { Authorization: `Bearer ${access_token}` }

// Step 3: Start a conversation
console.log('Starting conversation...')
const convRes = await post(`${WEBCLIENT}/conversations`, {}, auth)
console.log('Conversation status:', convRes.status)
if (convRes.status !== 200 && convRes.status !== 201) {
  console.error(convRes.body)
  const corr = convRes.headers['x-vcap-request-id'] || convRes.headers['x-request-id']
  if (corr) console.error('Correlation ID:', corr)
  process.exit(1)
}
const conv = JSON.parse(convRes.body)
console.log('Conversation:', JSON.stringify(conv).slice(0, 200))
const conversationId = conv.results?.thread_id || conv.id || conv.conversationId

// Step 4: Send "list books"
console.log('\nSending "list books"...')
const msgRes = await post(
  `${WEBCLIENT}`,
  { message: { attachment: { type: 'text', content: 'list books' } } },
  auth
)
console.log('Message status:', msgRes.status)
if (msgRes.status !== 200) { console.error(msgRes.body); process.exit(1) }

// Step 5: Poll for bot response (skip user echo and status_update)
console.log('Polling for response...')
let response = null
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1000))
  const pollRes = await get(`${WEBCLIENT}/messages`, auth)
  if (pollRes.status !== 200) { console.error('Poll failed:', pollRes.status, pollRes.body); break }
  const data = JSON.parse(pollRes.body)
  const botAnswer = (data.results?.messages || []).find(
    m => m.participant?.isBot && m.attachment?.type === 'text'
  )
  if (botAnswer) { response = botAnswer; break }
}
console.log('Joule response:', JSON.stringify(response, null, 2))

// ── Scenario: two subsequent queries in the same conversation ──────────────

async function pollBotResponse(afterMessageId) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const pollRes = await get(`${WEBCLIENT}/messages`, auth)
    if (pollRes.status !== 200) { console.error('Poll failed:', pollRes.status, pollRes.body); return null }
    const data = JSON.parse(pollRes.body)
    const messages = data.results?.messages || []
    // find a bot text message that came after the given message id (larger numeric id)
    const botAnswer = messages.find(
      m => m.participant?.isBot && m.attachment?.type === 'text' && m.id > afterMessageId
    )
    if (botAnswer) return botAnswer
  }
  return null
}

console.log('\n── Scenario: subsequent queries ──')

// Query 1: list books
console.log('\n[Scenario] Starting conversation...')
const sConvRes = await post(`${WEBCLIENT}/conversations`, {}, auth)
if (sConvRes.status !== 200 && sConvRes.status !== 201) { console.error('Scenario conv failed:', sConvRes.status, sConvRes.body); process.exit(1) }

console.log('[Scenario] Sending "list books"...')
const sMsg1Res = await post(`${WEBCLIENT}`, { message: { attachment: { type: 'text', content: 'list books' } } }, auth)
if (sMsg1Res.status !== 200) { console.error('[Scenario] msg1 failed:', sMsg1Res.status, sMsg1Res.body); process.exit(1) }

console.log('[Scenario] Polling for response to "list books"...')
const sResp1 = await pollBotResponse('0')
if (!sResp1) { console.error('[Scenario] No response to "list books"'); process.exit(1) }
console.log('[Scenario] Response 1:', sResp1.attachment?.content?.slice(0, 200))

const listedBooks = ['Wuthering Heights', 'Jane Eyre', 'The Raven', 'Eleonora', 'Catweazle']
const allFound = listedBooks.every(b => sResp1.attachment?.content?.includes(b))
console.log('[Scenario] All books listed:', allFound)
if (!allFound) { console.error('[Scenario] FAIL: not all books present in response'); process.exit(1) }

// Query 2: ask about The Raven, in the same conversation
console.log('\n[Scenario] Sending "tell me about The Raven"...')
const sMsg2Res = await post(`${WEBCLIENT}`, { message: { attachment: { type: 'text', content: 'tell me about The Raven' } } }, auth)
if (sMsg2Res.status !== 200) { console.error('[Scenario] msg2 failed:', sMsg2Res.status, sMsg2Res.body); process.exit(1) }

console.log('[Scenario] Polling for response to "tell me about The Raven"...')
const sResp2 = await pollBotResponse(sResp1.id)
if (!sResp2) { console.error('[Scenario] No response to "tell me about The Raven"'); process.exit(1) }
console.log('[Scenario] Response 2:', sResp2.attachment?.content?.slice(0, 400))

const mentionsRaven = sResp2.attachment?.content?.toLowerCase().includes('raven')
const mentionsPoe = sResp2.attachment?.content?.toLowerCase().includes('poe')
console.log('[Scenario] Mentions "Raven":', mentionsRaven, '| Mentions "Poe":', mentionsPoe)
if (!mentionsRaven) { console.error('[Scenario] FAIL: response does not mention The Raven'); process.exit(1) }

console.log('\n[Scenario] PASS: both queries succeeded in the same conversation.')
