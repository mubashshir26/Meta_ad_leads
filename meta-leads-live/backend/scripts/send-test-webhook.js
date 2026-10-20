/**
 * Sends a correctly signed fake `leadgen` webhook to the local server.
 * For smoke-testing the backend only. The real demo uses Meta's Lead Testing Tool.
 *
 *   node scripts/send-test-webhook.js [baseUrl]
 */
require('dotenv').config();
const crypto = require('crypto');

const base = process.argv[2] || `http://localhost:${process.env.PORT || 3000}`;
const secret = process.env.APP_SECRET || '';

const payload = {
  object: 'page',
  entry: [
    {
      id: '111111111111111',
      time: Math.floor(Date.now() / 1000),
      changes: [
        {
          field: 'leadgen',
          value: {
            leadgen_id: String(Date.now()),
            form_id: '222222222222222',
            page_id: '111111111111111',
            ad_id: '333333333333333',
            created_time: Math.floor(Date.now() / 1000),
          },
        },
      ],
    },
  ],
};

const body = JSON.stringify(payload);
const headers = { 'Content-Type': 'application/json' };
if (secret) {
  headers['X-Hub-Signature-256'] =
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

fetch(`${base}/webhook`, { method: 'POST', headers, body })
  .then((r) => console.log('webhook ->', r.status))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
