import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTransaction,
  checkEligibility,
  estimateFee,
  rankMethods,
  rulesDecision,
  ValidationError,
} from '../src/engine.js';

const base = { amount: 180, currency: 'USD', buyerCountry: 'US', device: 'mobile', buyerProfile: 'new', priority: 'net' };

test('normalizeTransaction applies defaults and rounds the amount', () => {
  const tx = normalizeTransaction({ amount: '19.999' });
  assert.equal(tx.amount, 20);
  assert.equal(tx.currency, 'USD');
  assert.equal(tx.buyerCountry, 'US');
  assert.equal(tx.device, 'desktop');
  assert.equal(tx.buyerProfile, 'new');
  assert.equal(tx.priority, 'net');
  assert.equal(tx.item, 'Demo order');
});

test('normalizeTransaction rejects bad input with the field name', () => {
  const cases = [
    [{ amount: 0 }, 'amount'],
    [{ amount: 20000 }, 'amount'],
    [{ amount: 10, currency: 'JPY' }, 'currency'],
    [{ amount: 10, buyerCountry: 'ZZ' }, 'buyerCountry'],
    [{ amount: 10, device: 'tv' }, 'device'],
    [{ amount: 10, buyerProfile: 'vip' }, 'buyerProfile'],
    [{ amount: 10, priority: 'speed' }, 'priority'],
  ];
  for (const [input, field] of cases) {
    assert.throws(() => normalizeTransaction(input), (err) => err instanceof ValidationError && err.field === field);
  }
});

test('Venmo is only eligible for US buyers paying in USD', () => {
  assert.equal(checkEligibility('venmo', normalizeTransaction(base)).eligible, true);
  assert.equal(checkEligibility('venmo', normalizeTransaction({ ...base, buyerCountry: 'FR', currency: 'EUR' })).eligible, false);
  assert.equal(checkEligibility('venmo', normalizeTransaction({ ...base, currency: 'EUR' })).eligible, false);
});

test('Pay Later respects country, currency and amount range', () => {
  assert.equal(checkEligibility('paylater', normalizeTransaction(base)).eligible, true);
  assert.equal(checkEligibility('paylater', normalizeTransaction({ ...base, amount: 20 })).eligible, false);
  assert.equal(checkEligibility('paylater', normalizeTransaction({ ...base, amount: 2500 })).eligible, false);
  assert.equal(checkEligibility('paylater', normalizeTransaction({ ...base, buyerCountry: 'DE', currency: 'EUR' })).eligible, false);
  assert.equal(checkEligibility('paylater', normalizeTransaction({ ...base, buyerCountry: 'FR', currency: 'USD' })).eligible, false);
  assert.equal(checkEligibility('paylater', normalizeTransaction({ ...base, buyerCountry: 'FR', currency: 'EUR', amount: 1299 })).eligible, true);
});

test('estimateFee combines the percentage and fixed fee', () => {
  assert.equal(estimateFee('paypal', 100), 3.98);
  assert.equal(estimateFee('card', 100), 3.48);
});

test('rankMethods ranks eligible methods first and recommends the top one', () => {
  const route = rankMethods(normalizeTransaction({ ...base, buyerCountry: 'GB', currency: 'GBP' }));
  const eligible = route.candidates.filter((c) => c.eligible);
  const blocked = route.candidates.filter((c) => !c.eligible);
  assert.deepEqual(eligible.map((c) => c.rank), eligible.map((_, i) => i + 1));
  assert.ok(blocked.every((c) => c.rank === null));
  assert.equal(route.candidates.indexOf(blocked[0]), eligible.length);
  assert.equal(route.recommended, eligible[0].id);
  assert.ok(blocked.some((c) => c.id === 'venmo'));
});

test('a guest buyer is routed to card checkout', () => {
  const route = rankMethods(normalizeTransaction({ ...base, buyerProfile: 'guest', device: 'desktop', priority: 'conversion' }));
  assert.equal(route.recommended, 'card');
});

test('a returning PayPal user on desktop is routed to PayPal', () => {
  const route = rankMethods(normalizeTransaction({ ...base, amount: 60, device: 'desktop', buyerProfile: 'returning_paypal' }));
  assert.equal(route.recommended, 'paypal');
});

test('a large order from a new buyer leans to Pay Later', () => {
  const route = rankMethods(normalizeTransaction({ ...base, amount: 900, device: 'desktop' }));
  assert.equal(route.recommended, 'paylater');
});

test('the fees goal picks the cheapest eligible method', () => {
  const route = rankMethods(normalizeTransaction({ ...base, priority: 'fees' }));
  const cheapest = Math.min(...route.candidates.filter((c) => c.eligible).map((c) => c.fee));
  assert.equal(route.candidates[0].fee, cheapest);
});

test('expected revenue is completion rate times amount after fees', () => {
  const route = rankMethods(normalizeTransaction(base));
  for (const c of route.candidates) {
    assert.ok(Math.abs(c.expectedNet - c.conversion * (180 - c.fee)) < 0.01);
  }
});

test('rulesDecision explains the top choice', () => {
  const route = rankMethods(normalizeTransaction(base));
  const d = rulesDecision(route);
  assert.equal(d.fundingSource, route.recommended);
  assert.equal(d.decidedBy, 'rules');
  assert.match(d.reasoning, /expected revenue/);
});
