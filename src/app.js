import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { normalizeTransaction, rankMethods, rulesDecision, ValidationError } from './engine.js';
import { decideWithAI } from './ai.js';
import { PayPalError } from './paypal.js';
import { METHODS, CURRENCIES, COUNTRIES, BUYER_PROFILES, PRIORITIES } from './methods.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_DECISIONS = 50;
const ORDER_ID_PATTERN = /^[A-Z0-9]{8,36}$/;

export async function routeTransaction(input, { aiConfig, fetchImpl = fetch, logger = console }) {
  const tx = normalizeTransaction(input);
  const route = rankMethods(tx);

  let decision;
  if (aiConfig.provider !== 'none') {
    try {
      decision = await decideWithAI(route, aiConfig, fetchImpl);
    } catch (err) {
      logger.warn?.(`[ai] falling back to rules: ${err.message}`);
      decision = rulesDecision(route, 'The AI model did not answer in time, so the rules engine decided.');
    }
  } else {
    decision = rulesDecision(route);
  }

  return {
    ...route,
    decision: { ...decision, agreesWithRules: decision.fundingSource === route.recommended },
  };
}

function createRateLimiter(limitPerMinute) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const windowStart = Date.now() - 60_000;
    const recent = (hits.get(key) || []).filter((t) => t > windowStart);
    if (recent.length >= limitPerMinute) {
      res.status(429).json({ error: 'Too many routing requests. Wait a minute and try again.' });
      return;
    }
    recent.push(Date.now());
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

function summarize(d) {
  return {
    id: d.id,
    createdAt: d.createdAt,
    amount: d.transaction.amount,
    currency: d.transaction.currency,
    buyerCountry: d.transaction.buyerCountry,
    device: d.transaction.device,
    item: d.transaction.item,
    fundingSource: d.decision.fundingSource,
    decidedBy: d.decision.decidedBy,
    model: d.decision.model,
    outcome: d.outcome,
  };
}

export function createApp({ config, paypal, fetchImpl = fetch, logger = console }) {
  const app = express();
  const decisions = new Map(); // id -> decision record (in memory, newest last)

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(PUBLIC_DIR));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, paypalConfigured: paypal.isConfigured, aiProvider: config.ai.provider });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      environment: 'sandbox',
      brandName: config.brandName,
      paypal: {
        configured: paypal.isConfigured,
        clientId: paypal.isConfigured ? config.paypal.clientId : null,
      },
      ai: {
        provider: config.ai.provider,
        model:
          config.ai.provider === 'gemini'
            ? config.ai.geminiModel
            : config.ai.provider === 'anthropic'
              ? config.ai.anthropicModel
              : null,
      },
      options: {
        currencies: CURRENCIES,
        countries: COUNTRIES,
        buyerProfiles: BUYER_PROFILES,
        priorities: PRIORITIES,
        methods: Object.fromEntries(Object.values(METHODS).map((m) => [m.id, m.label])),
      },
    });
  });

  app.post('/api/route', createRateLimiter(config.routeRateLimitPerMinute), async (req, res, next) => {
    try {
      const result = await routeTransaction(req.body, { aiConfig: config.ai, fetchImpl, logger });
      const record = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...result,
        orders: [],
        outcome: null,
      };
      decisions.set(record.id, record);
      while (decisions.size > MAX_DECISIONS) decisions.delete(decisions.keys().next().value);
      res.json(record);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/decisions', (req, res) => {
    res.json([...decisions.values()].reverse().map(summarize));
  });

  app.post('/api/orders', async (req, res, next) => {
    try {
      if (!paypal.isConfigured) {
        res.status(503).json({ error: 'PayPal sandbox is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.' });
        return;
      }
      const record = decisions.get(String(req.body?.routeId || ''));
      if (!record) {
        res.status(404).json({ error: 'This routing decision has expired. Route the transaction again.' });
        return;
      }
      const fundingSource = String(req.body?.fundingSource || record.decision.fundingSource);
      const candidate = record.candidates.find((c) => c.id === fundingSource);
      if (!candidate || !candidate.eligible) {
        res.status(400).json({ error: 'That payment method is not available for this transaction.' });
        return;
      }

      const tx = record.transaction;
      const order = await paypal.createOrder({
        amount: tx.amount,
        currency: tx.currency,
        description: `${tx.item} (${config.brandName})`,
        referenceId: record.id,
      });
      record.orders.push({ orderId: order.id, fundingSource, status: order.status });
      res.json({ id: order.id, status: order.status });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/orders/:orderId/capture', async (req, res, next) => {
    try {
      if (!paypal.isConfigured) {
        res.status(503).json({ error: 'PayPal sandbox is not configured.' });
        return;
      }
      const { orderId } = req.params;
      if (!ORDER_ID_PATTERN.test(orderId)) {
        res.status(400).json({ error: 'Invalid order ID.' });
        return;
      }
      const record = [...decisions.values()].find((d) => d.orders.some((o) => o.orderId === orderId));
      if (!record) {
        res.status(404).json({ error: 'Unknown order. Route the transaction again.' });
        return;
      }

      let data;
      try {
        data = await paypal.captureOrder(orderId);
      } catch (err) {
        if (err instanceof PayPalError && err.issue === 'INSTRUMENT_DECLINED') {
          res.status(422).json({ issue: 'INSTRUMENT_DECLINED', error: 'The payment method was declined. Choose another one.' });
          return;
        }
        throw err;
      }

      const capture = data?.purchase_units?.[0]?.payments?.captures?.[0] || null;
      const order = record.orders.find((o) => o.orderId === orderId);
      order.status = data.status;
      record.outcome = {
        orderId,
        status: data.status,
        captureId: capture?.id || null,
        captureStatus: capture?.status || null,
        pendingReason: capture?.status_details?.reason || null,
        fundingSource: order.fundingSource,
        amount: capture?.amount || null,
        capturedAt: new Date().toISOString(),
      };
      res.json(record.outcome);
    } catch (err) {
      next(err);
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    if (err instanceof PayPalError) {
      logger.error?.(`[paypal] ${err.status} ${err.issue || ''} ${err.message} debug_id=${err.debugId}`);
      res.status(502).json({ error: `PayPal: ${err.message}`, debugId: err.debugId, issue: err.issue });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Request body must be valid JSON.' });
      return;
    }
    logger.error?.(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}
