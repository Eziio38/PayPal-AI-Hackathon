import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { PayPalError } from '../src/paypal.js';

const silentLogger = { warn() {}, error() {} };

function fakePayPalClient({ captureError } = {}) {
  let n = 0;
  return {
    isConfigured: true,
    created: [],
    async createOrder(args) {
      n += 1;
      const id = `ORDER${String(n).padStart(8, '0')}`;
      this.created.push({ id, ...args });
      return { id, status: 'CREATED' };
    },
    async captureOrder(orderId) {
      if (captureError) throw captureError;
      const order = this.created.find((o) => o.id === orderId);
      return {
        id: orderId,
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [{ id: 'CAP123', status: 'COMPLETED', amount: { currency_code: order.currency, value: order.amount.toFixed(2) } }],
            },
          },
        ],
      };
    },
  };
}

async function startServer(paypal, envOverrides = {}) {
  const config = loadConfig({ ...envOverrides });
  const app = createApp({ config, paypal, logger: silentLogger });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null), text: res.headers.get('content-type') };
  };
  return { server, call };
}

const sneakers = { item: 'Sneakers', amount: 180, currency: 'USD', buyerCountry: 'US', device: 'mobile', buyerProfile: 'new', priority: 'net' };

let configured;
let unconfigured;

before(async () => {
  configured = await startServer(fakePayPalClient(), { PAYPAL_CLIENT_ID: 'client-id', PAYPAL_CLIENT_SECRET: 'secret' });
  unconfigured = await startServer({ isConfigured: false });
});

after(() => {
  configured.server.close();
  unconfigured.server.close();
});

test('serves the front end', async () => {
  const res = await fetch(`http://127.0.0.1:${configured.server.address().port}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /SmartPay Routing/);
});

test('/api/config exposes the client id but never the secret', async () => {
  const { status, data } = await configured.call('/api/config');
  assert.equal(status, 200);
  assert.equal(data.paypal.clientId, 'client-id');
  assert.equal(JSON.stringify(data).includes('secret'), false);
  assert.equal(data.ai.provider, 'none');
});

test('/api/route returns ranked candidates and a decision', async () => {
  const { status, data } = await configured.call('/api/route', { method: 'POST', body: sneakers });
  assert.equal(status, 200);
  assert.ok(data.id);
  assert.equal(data.candidates.length, 4);
  assert.equal(data.decision.decidedBy, 'rules');
  assert.equal(data.decision.fundingSource, data.recommended);
});

test('/api/route validates input', async () => {
  const { status, data } = await configured.call('/api/route', { method: 'POST', body: { ...sneakers, amount: -5 } });
  assert.equal(status, 400);
  assert.equal(data.field, 'amount');

  const bad = await configured.call('/api/route', { method: 'POST', body: '{not json' });
  assert.equal(bad.status, 400);
});

test('full sandbox flow: route, create order, capture, log', async () => {
  const route = await configured.call('/api/route', { method: 'POST', body: sneakers });
  const order = await configured.call('/api/orders', {
    method: 'POST',
    body: { routeId: route.data.id, fundingSource: route.data.decision.fundingSource },
  });
  assert.equal(order.status, 200);
  assert.match(order.data.id, /^ORDER/);

  const capture = await configured.call(`/api/orders/${order.data.id}/capture`, { method: 'POST' });
  assert.equal(capture.status, 200);
  assert.equal(capture.data.status, 'COMPLETED');
  assert.equal(capture.data.captureId, 'CAP123');
  assert.deepEqual(capture.data.amount, { currency_code: 'USD', value: '180.00' });

  const log = await configured.call('/api/decisions');
  const row = log.data.find((r) => r.id === route.data.id);
  assert.equal(row.outcome.status, 'COMPLETED');
});

test('orders use the server-side amount, not anything the browser sends', async () => {
  const paypal = fakePayPalClient();
  const { server, call } = await startServer(paypal, { PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' });
  try {
    const route = await call('/api/route', { method: 'POST', body: sneakers });
    await call('/api/orders', { method: 'POST', body: { routeId: route.data.id, amount: 0.01 } });
    assert.equal(paypal.created[0].amount, 180);
    assert.equal(paypal.created[0].currency, 'USD');
  } finally {
    server.close();
  }
});

test('orders refuse ineligible methods and unknown routes', async () => {
  const fr = await configured.call('/api/route', { method: 'POST', body: { ...sneakers, currency: 'EUR', buyerCountry: 'FR' } });
  const venmo = await configured.call('/api/orders', { method: 'POST', body: { routeId: fr.data.id, fundingSource: 'venmo' } });
  assert.equal(venmo.status, 400);

  const unknown = await configured.call('/api/orders', { method: 'POST', body: { routeId: 'nope' } });
  assert.equal(unknown.status, 404);

  const badId = await configured.call('/api/orders/abc!/capture', { method: 'POST' });
  assert.equal(badId.status, 400);
});

test('a declined instrument returns 422 so the buyer can pick again', async () => {
  const declined = new PayPalError('Declined', { status: 422, issue: 'INSTRUMENT_DECLINED' });
  const { server, call } = await startServer(fakePayPalClient({ captureError: declined }), { PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' });
  try {
    const route = await call('/api/route', { method: 'POST', body: sneakers });
    const order = await call('/api/orders', { method: 'POST', body: { routeId: route.data.id } });
    const capture = await call(`/api/orders/${order.data.id}/capture`, { method: 'POST' });
    assert.equal(capture.status, 422);
    assert.equal(capture.data.issue, 'INSTRUMENT_DECLINED');
  } finally {
    server.close();
  }
});

test('without PayPal credentials, routing works and orders return 503', async () => {
  const route = await unconfigured.call('/api/route', { method: 'POST', body: sneakers });
  assert.equal(route.status, 200);
  const order = await unconfigured.call('/api/orders', { method: 'POST', body: { routeId: route.data.id } });
  assert.equal(order.status, 503);
  const cfg = await unconfigured.call('/api/config');
  assert.equal(cfg.data.paypal.clientId, null);
});

test('routing is rate limited per client', async () => {
  const { server, call } = await startServer(fakePayPalClient(), { ROUTE_RATE_LIMIT: '2' });
  try {
    assert.equal((await call('/api/route', { method: 'POST', body: sneakers })).status, 200);
    assert.equal((await call('/api/route', { method: 'POST', body: sneakers })).status, 200);
    assert.equal((await call('/api/route', { method: 'POST', body: sneakers })).status, 429);
  } finally {
    server.close();
  }
});

test('unknown API routes return JSON 404', async () => {
  const { status, data } = await configured.call('/api/nothing');
  assert.equal(status, 404);
  assert.equal(data.error, 'Not found.');
});
