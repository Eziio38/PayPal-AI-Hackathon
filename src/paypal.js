// Minimal PayPal REST client for the sandbox (Orders v2).
// - OAuth 2.0 client-credentials token, cached until shortly before expiry
// - Create an order (intent CAPTURE)
// - Capture an approved order

import { randomUUID } from 'node:crypto';
import { PAYPAL_SANDBOX_API } from './config.js';

export class PayPalError extends Error {
  constructor(message, { status, debugId, issue } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.debugId = debugId || null;
    this.issue = issue || null;
  }
}

export function createPayPalClient({ clientId, clientSecret, baseUrl = PAYPAL_SANDBOX_API, fetchImpl = fetch, now = Date.now }) {
  let token = null;
  let tokenExpiresAt = 0;

  async function getAccessToken() {
    if (token && now() < tokenExpiresAt) return token;
    const res = await fetchImpl(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new PayPalError(`PayPal authentication failed (${res.status}). Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.`, {
        status: res.status,
      });
    }
    token = body.access_token;
    tokenExpiresAt = now() + Math.max(0, (Number(body.expires_in) || 0) - 60) * 1000;
    return token;
  }

  async function request(method, path, { body, requestId } = {}) {
    const accessToken = await getAccessToken();
    const headers = {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    };
    if (requestId) headers['paypal-request-id'] = requestId;

    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const issue = data?.details?.[0]?.issue || null;
      const description = data?.details?.[0]?.description || data?.message || 'PayPal request failed.';
      throw new PayPalError(description, { status: res.status, debugId: data?.debug_id, issue });
    }
    return data;
  }

  return {
    isConfigured: Boolean(clientId && clientSecret),

    async createOrder({ amount, currency, description, referenceId }) {
      return request('POST', '/v2/checkout/orders', {
        requestId: randomUUID(),
        body: {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: referenceId,
              custom_id: referenceId,
              description: description.slice(0, 127),
              amount: { currency_code: currency, value: amount.toFixed(2) },
            },
          ],
        },
      });
    },

    async captureOrder(orderId) {
      return request('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        requestId: `capture-${orderId}`,
        body: {},
      });
    },
  };
}
