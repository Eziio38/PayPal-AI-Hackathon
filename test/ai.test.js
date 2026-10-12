import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDecision, decideWithAI, buildUserPrompt, AIError } from '../src/ai.js';
import { normalizeTransaction, rankMethods } from '../src/engine.js';
import { routeTransaction } from '../src/app.js';

const tx = normalizeTransaction({ amount: 180, currency: 'USD', buyerCountry: 'US', device: 'mobile', notes: 'Gift for a friend' });
const route = rankMethods(tx);
const eligible = route.candidates.filter((c) => c.eligible).map((c) => c.id);
const silentLogger = { warn() {}, error() {} };

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const { status = 200, json } = handler(url, init);
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

test('parseDecision accepts clean JSON and JSON wrapped in prose or fences', () => {
  const clean = parseDecision('{"fundingSource":"venmo","confidence":0.82,"reasoning":"Mobile US shopper."}', eligible);
  assert.deepEqual(clean, { fundingSource: 'venmo', confidence: 0.82, reasoning: 'Mobile US shopper.' });

  const fenced = parseDecision('```json\n{"fundingSource":"PayPal","confidence":2,"reasoning":"x"}\n```', eligible);
  assert.equal(fenced.fundingSource, 'paypal');
  assert.equal(fenced.confidence, 1);
});

test('parseDecision rejects ineligible or malformed answers', () => {
  const de = rankMethods(normalizeTransaction({ amount: 50, currency: 'EUR', buyerCountry: 'DE' }));
  const deEligible = de.candidates.filter((c) => c.eligible).map((c) => c.id);
  assert.throws(() => parseDecision('{"fundingSource":"venmo","reasoning":"x"}', deEligible), AIError);
  assert.throws(() => parseDecision('no json here', eligible), AIError);
  assert.throws(() => parseDecision('{"fundingSource":', eligible), AIError);
  assert.throws(() => parseDecision('{"fundingSource":"card"}', eligible), AIError);
});

test('the prompt lists eligibility, estimates and the merchant notes', () => {
  const prompt = buildUserPrompt(route);
  assert.match(prompt, /Gift for a friend/);
  assert.match(prompt, /venmo: eligible/);
  assert.match(prompt, /expected revenue after fees/);
});

test('decideWithAI calls Gemini generateContent with JSON output', async () => {
  const fetchImpl = fakeFetch(() => ({
    json: { candidates: [{ content: { parts: [{ text: '{"fundingSource":"venmo","confidence":0.7,"reasoning":"Young mobile buyer."}' }] } }] },
  }));
  const d = await decideWithAI(route, { provider: 'gemini', geminiKey: 'k', geminiModel: 'gemini-test', timeoutMs: 1000 }, fetchImpl);
  assert.equal(d.fundingSource, 'venmo');
  assert.equal(d.decidedBy, 'ai');
  assert.equal(d.model, 'gemini-test');

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.equal(call.init.headers['x-goog-api-key'], 'k');
  assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
  assert.match(call.body.systemInstruction.parts[0].text, /routing brain/);
});

test('decideWithAI ignores Gemini thought parts', async () => {
  const fetchImpl = fakeFetch(() => ({
    json: {
      candidates: [{ content: { parts: [{ text: 'thinking {"fundingSource":"card"}', thought: true }, { text: '{"fundingSource":"paypal","reasoning":"Saved wallet."}' }] } }],
    },
  }));
  const d = await decideWithAI(route, { provider: 'gemini', geminiKey: 'k', geminiModel: 'm', timeoutMs: 1000 }, fetchImpl);
  assert.equal(d.fundingSource, 'paypal');
});

test('decideWithAI calls the Claude Messages API', async () => {
  const fetchImpl = fakeFetch(() => ({
    json: { content: [{ type: 'text', text: '{"fundingSource":"paylater","confidence":0.6,"reasoning":"High order value."}' }] },
  }));
  const d = await decideWithAI(route, { provider: 'anthropic', anthropicKey: 'a', anthropicModel: 'claude-test', timeoutMs: 1000 }, fetchImpl);
  assert.equal(d.fundingSource, 'paylater');
  assert.equal(d.provider, 'anthropic');

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.init.headers['x-api-key'], 'a');
  assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.body.model, 'claude-test');
});

test('API errors surface as AIError', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 429, json: { error: { message: 'quota' } } }));
  await assert.rejects(
    decideWithAI(route, { provider: 'gemini', geminiKey: 'k', geminiModel: 'm', timeoutMs: 1000 }, fetchImpl),
    (err) => err instanceof AIError && /429/.test(err.message),
  );
});

test('routeTransaction falls back to the rules engine when the AI fails', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 500, json: {} }));
  const result = await routeTransaction(
    { amount: 180, currency: 'USD', buyerCountry: 'US', device: 'mobile' },
    { aiConfig: { provider: 'gemini', geminiKey: 'k', geminiModel: 'm', timeoutMs: 1000 }, fetchImpl, logger: silentLogger },
  );
  assert.equal(result.decision.decidedBy, 'rules');
  assert.equal(result.decision.fundingSource, result.recommended);
  assert.equal(result.decision.agreesWithRules, true);
  assert.match(result.decision.reasoning, /rules engine decided/);
});

test('routeTransaction reports when the AI overrides the rules engine', async () => {
  const fetchImpl = fakeFetch(() => ({
    json: { candidates: [{ content: { parts: [{ text: '{"fundingSource":"card","confidence":0.9,"reasoning":"Corporate card buyer."}' }] } }] },
  }));
  const result = await routeTransaction(
    { amount: 640, currency: 'GBP', buyerCountry: 'GB', device: 'desktop', notes: 'Pays with a corporate card' },
    { aiConfig: { provider: 'gemini', geminiKey: 'k', geminiModel: 'm', timeoutMs: 1000 }, fetchImpl, logger: silentLogger },
  );
  assert.equal(result.decision.fundingSource, 'card');
  assert.equal(result.decision.decidedBy, 'ai');
  assert.equal(result.decision.agreesWithRules, result.recommended === 'card');
});
