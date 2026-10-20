/**
 * Meta Lead Ads -> live React Native feed
 *
 * Flow:
 *   Meta Lead Ad submit / Lead Testing Tool
 *     -> POST /webhook  (leadgen event: only IDs, no personal data)
 *     -> verify X-Hub-Signature-256
 *     -> fetch full lead from Graph API (GET /{leadgen_id})
 *     -> store (in-memory + JSON file) and broadcast over WebSocket (/ws)
 *     -> React Native app receives it and renders it instantly
 */
require('dotenv').config();

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const {
  PORT = 3000,
  VERIFY_TOKEN,
  APP_SECRET,
  PAGE_ACCESS_TOKEN,
  GRAPH_VERSION = 'v23.0',
  DEV_MOCK_GRAPH = 'false', // local testing only: skips the Graph API call
  ENABLE_DEV_ROUTES = 'false',
} = process.env;

const DATA_FILE = path.join(__dirname, 'data', 'leads.json');
const MAX_LEADS = 500;

// ---------------------------------------------------------------- storage
let leads = [];
try {
  leads = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  leads = [];
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
  } catch (err) {
    console.error('[store] persist failed:', err.message);
  }
}

const seen = new Set(leads.map((l) => l.id)); // dedupe: Meta may retry deliveries

// ------------------------------------------------------------- websocket
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  // Snapshot on every (re)connect => app never misses a lead after a drop.
  ws.send(JSON.stringify({ type: 'snapshot', leads }));
  console.log(`[ws] client connected (${wss.clients.size} total)`);
});

// Heartbeat: drop dead connections so the app's reconnect logic kicks in.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// ---------------------------------------------------------------- helpers
function verifySignature(req) {
  if (!APP_SECRET) {
    console.warn('[webhook] APP_SECRET not set - skipping signature check (dev only!)');
    return true;
  }
  const header = req.get('x-hub-signature-256');
  if (!header || !req.rawBody) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchLeadFromGraph(leadgenId) {
  if (DEV_MOCK_GRAPH === 'true') {
    return {
      id: leadgenId,
      created_time: new Date().toISOString(),
      field_data: [
        { name: 'full_name', values: ['Mock Tester'] },
        { name: 'email', values: ['mock.tester@example.com'] },
        { name: 'phone_number', values: ['+910000000000'] },
      ],
    };
  }
  if (!PAGE_ACCESS_TOKEN) throw new Error('PAGE_ACCESS_TOKEN not set');

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}`;
  let lastErr;
  // The lead can take a moment to become readable; retry with backoff.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
      return body;
    } catch (err) {
      lastErr = err;
      console.warn(`[graph] attempt ${attempt} failed: ${err.message}`);
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

function normalizeLead(graphLead, meta) {
  const fields = {};
  for (const f of graphLead?.field_data || []) {
    fields[f.name] = Array.isArray(f.values) ? f.values.join(', ') : String(f.values ?? '');
  }
  return {
    id: meta.leadgenId,
    createdTime: graphLead?.created_time || meta.createdTime || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    formId: meta.formId || null,
    pageId: meta.pageId || null,
    adId: meta.adId || null,
    fields,
    resolved: Boolean(graphLead), // false => only IDs were available
  };
}

async function handleLeadgen(value) {
  const leadgenId = String(value.leadgen_id);
  if (seen.has(leadgenId)) {
    console.log(`[lead] duplicate ${leadgenId} ignored`);
    return;
  }
  seen.add(leadgenId);

  const meta = {
    leadgenId,
    formId: value.form_id && String(value.form_id),
    pageId: value.page_id && String(value.page_id),
    adId: value.ad_id && String(value.ad_id),
    createdTime: value.created_time && new Date(value.created_time * 1000).toISOString(),
  };

  let graphLead = null;
  try {
    graphLead = await fetchLeadFromGraph(leadgenId);
  } catch (err) {
    // Still surface the lead so the pipeline is visible end-to-end.
    console.error(`[graph] could not resolve lead ${leadgenId}: ${err.message}`);
  }

  const lead = normalizeLead(graphLead, meta);
  leads.unshift(lead);
  if (leads.length > MAX_LEADS) leads = leads.slice(0, MAX_LEADS);
  persist();
  broadcast({ type: 'lead', lead });
  console.log(`[lead] ${lead.id} broadcast to ${wss.clients.size} client(s)`);
}

async function processPayload(body) {
  if (body?.object !== 'page') return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'leadgen' && change.value?.leadgen_id) {
        await handleLeadgen(change.value);
      }
    }
  }
}

// ----------------------------------------------------------------- routes
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // keep exact bytes: the signature is over the raw body
    },
  })
);

// Meta calls this once when you click "Verify and save" on the webhook.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === VERIFY_TOKEN) {
    console.log('[webhook] verified by Meta');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) {
    console.warn('[webhook] invalid signature - rejected');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack immediately; Meta retries on slow/failed responses
  processPayload(req.body).catch((err) => console.error('[webhook] processing error:', err));
});

app.get('/leads', (_req, res) => res.json({ leads }));
app.get('/health', (_req, res) => res.json({ ok: true, leads: leads.length, clients: wss.clients.size }));

// Local-only helper to exercise the WS path without Meta (disabled by default).
if (ENABLE_DEV_ROUTES === 'true') {
  app.post('/dev/simulate', async (_req, res) => {
    await handleLeadgen({
      leadgen_id: String(Date.now()),
      form_id: 'dev-form',
      page_id: 'dev-page',
      created_time: Math.floor(Date.now() / 1000),
    });
    res.json({ ok: true });
  });
}

server.listen(PORT, () => {
  console.log(`Server listening on :${PORT}  (webhook: /webhook, websocket: /ws)`);
});
