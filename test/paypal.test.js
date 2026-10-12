import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPayPalClient, PayPalError } from '../src/paypal.js';

function fakePayPal(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, init, body: init.body && path !== '/v1/oauth2/token' ? JSON.parse(init.body) : init.body });
    const handler = routes[path] || routes['*'];
    const { status = 200, json } = handler(path, init);
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return { fetchImpl, calls };
}

const tokenRoute = () => ({ json: { access_token: 'tok', expires_in: 32400 } });

test('the access token is requested once and reused', async () => {
  const { fetchImpl, calls } = fakePayPal({
    '/v1/oauth2/token': tokenRoute,
    '*': () => ({ status: 201, json: { id: 'ORDER123456', status: 'CREATED' } }),
  });
  const client = createPayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  await client.createOrder({ amount: 10, currency: 'USD', description: 'Test', referenceId: 'r1' });
  await client.createOrder({ amount: 20, currency: 'USD', description: 'Test', referenceId: 'r2' });

  const tokenCalls = calls.filter((c) => c.path === '/v1/oauth2/token');
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].init.headers.authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
  assert.equal(tokenCalls[0].body, 'grant_type=client_credentials');
});

test('an expired token is refreshed', async () => {
  let now = 0;
  const { fetchImpl, calls } = fakePayPal({
    '/v1/oauth2/token': () => ({ json: { access_token: 'tok', expires_in: 120 } }),
    '*': () => ({ status: 201, json: { id: 'ORDER123456' } }),
  });
  const client = createPayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl, now: () => now });
  await client.createOrder({ amount: 10, currency: 'USD', description: 'a', referenceId: 'r' });
  now = 61_000;
  await client.createOrder({ amount: 10, currency: 'USD', description: 'a', referenceId: 'r' });
  assert.equal(calls.filter((c) => c.path === '/v1/oauth2/token').length, 2);
});

test('createOrder sends an Orders v2 CAPTURE order', async () => {
  const { fetchImpl, calls } = fakePayPal({
    '/v1/oauth2/token': tokenRoute,
    '/v2/checkout/orders': () => ({ status: 201, json: { id: 'ORDER123456', status: 'CREATED' } }),
  });
  const client = createPayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  const order = await client.createOrder({ amount: 1299, currency: 'EUR', description: 'Laptop', referenceId: 'route-1' });
  assert.equal(order.id, 'ORDER123456');

  const call = calls.find((c) => c.path === '/v2/checkout/orders');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.authorization, 'Bearer tok');
  assert.ok(call.init.headers['paypal-request-id']);
  assert.deepEqual(call.body, {
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: 'route-1', custom_id: 'route-1', description: 'Laptop', amount: { currency_code: 'EUR', value: '1299.00' } }],
  });
});

test('captureOrder posts to the capture endpoint with an idempotency key', async () => {
  const { fetchImpl, calls } = fakePayPal({
    '/v1/oauth2/token': tokenRoute,
    '/v2/checkout/orders/ORDER123456/capture': () => ({ status: 201, json: { id: 'ORDER123456', status: 'COMPLETED' } }),
  });
  const client = createPayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  const result = await client.captureOrder('ORDER123456');
  assert.equal(result.status, 'COMPLETED');
  const call = calls.find((c) => c.path.endsWith('/capture'));
  assert.equal(call.init.headers['paypal-request-id'], 'capture-ORDER123456');
});

test('PayPal errors carry the issue and debug id', async () => {
  const { fetchImpl } = fakePayPal({
    '/v1/oauth2/token': tokenRoute,
    '*': () => ({
      status: 422,
      json: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg1', details: [{ issue: 'INSTRUMENT_DECLINED', description: 'Declined.' }] },
    }),
  });
  const client = createPayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  await assert.rejects(client.captureOrder('ORDER123456'), (err) => {
    assert.ok(err instanceof PayPalError);
    assert.equal(err.issue, 'INSTRUMENT_DECLINED');
    assert.equal(err.debugId, 'dbg1');
    assert.equal(err.status, 422);
    return true;
  });
});

test('bad credentials produce a clear authentication error', async () => {
  const { fetchImpl } = fakePayPal({ '/v1/oauth2/token': () => ({ status: 401, json: { error: 'invalid_client' } }) });
  const client = createPayPalClient({ clientId: 'id', clientSecret: 'wrong', fetchImpl });
  await assert.rejects(client.createOrder({ amount: 1, currency: 'USD', description: 'a', referenceId: 'r' }), /authentication failed/);
});

test('isConfigured needs both credentials', () => {
  assert.equal(createPayPalClient({ clientId: 'id', clientSecret: '' }).isConfigured, false);
  assert.equal(createPayPalClient({ clientId: 'id', clientSecret: 's' }).isConfigured, true);
});
