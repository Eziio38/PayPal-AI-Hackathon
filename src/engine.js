// Deterministic routing engine.
// Scores every PayPal payment method for a transaction and ranks them.
// The AI layer (src/ai.js) works on top of this: it sees the same numbers
// plus the merchant's free-text context, and may pick a different method.

import {
  METHODS,
  METHOD_IDS,
  PAY_LATER_RULES,
  CURRENCIES,
  COUNTRIES,
  DEVICES,
  BUYER_PROFILES,
  PRIORITIES,
} from './methods.js';

export class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

const MAX_AMOUNT = 10000;

export function normalizeTransaction(input = {}) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('amount', 'Enter an amount greater than 0.');
  }
  if (amount > MAX_AMOUNT) {
    throw new ValidationError('amount', `Enter an amount of ${MAX_AMOUNT} or less.`);
  }

  const currency = String(input.currency || 'USD').toUpperCase();
  if (!CURRENCIES.includes(currency)) {
    throw new ValidationError('currency', `Currency must be one of ${CURRENCIES.join(', ')}.`);
  }

  const buyerCountry = String(input.buyerCountry || 'US').toUpperCase();
  if (!COUNTRIES[buyerCountry]) {
    throw new ValidationError('buyerCountry', 'Choose a supported buyer country.');
  }

  const device = String(input.device || 'desktop').toLowerCase();
  if (!DEVICES.includes(device)) {
    throw new ValidationError('device', 'Device must be mobile or desktop.');
  }

  const buyerProfile = String(input.buyerProfile || 'new');
  if (!BUYER_PROFILES[buyerProfile]) {
    throw new ValidationError('buyerProfile', 'Choose a buyer profile.');
  }

  const priority = String(input.priority || 'net');
  if (!PRIORITIES[priority]) {
    throw new ValidationError('priority', 'Choose a merchant goal.');
  }

  const item = String(input.item || 'Demo order').trim().slice(0, 120) || 'Demo order';
  const notes = String(input.notes || '').trim().slice(0, 500);

  return {
    amount: Math.round(amount * 100) / 100,
    currency,
    buyerCountry,
    device,
    buyerProfile,
    priority,
    item,
    notes,
  };
}

export function checkEligibility(methodId, tx) {
  if (methodId === 'venmo') {
    if (tx.buyerCountry !== 'US' || tx.currency !== 'USD') {
      return { eligible: false, reason: 'Venmo is only for US buyers paying in USD.' };
    }
  }
  if (methodId === 'paylater') {
    const rule = PAY_LATER_RULES[tx.buyerCountry];
    if (!rule) {
      return { eligible: false, reason: `Pay Later is not offered to buyers in ${COUNTRIES[tx.buyerCountry]} in this demo.` };
    }
    if (rule.currency !== tx.currency) {
      return { eligible: false, reason: `Pay Later in ${COUNTRIES[tx.buyerCountry]} needs ${rule.currency}.` };
    }
    if (tx.amount < rule.min || tx.amount > rule.max) {
      return { eligible: false, reason: `Pay Later covers orders from ${rule.min} to ${rule.max} ${rule.currency}.` };
    }
  }
  return { eligible: true, reason: null };
}

export function estimateFee(methodId, amount) {
  const m = METHODS[methodId];
  return round2((amount * m.feePct) / 100 + m.feeFixed);
}

// Heuristic completion rate for each method given who the buyer is.
// Kept deliberately simple and readable so judges can audit it.
export function estimateConversion(methodId, tx) {
  let p = METHODS[methodId].baseConversion;

  if (tx.buyerProfile === 'returning_paypal') {
    p += methodId === 'paypal' ? 0.14 : -0.03;
  } else if (tx.buyerProfile === 'guest') {
    if (methodId === 'card') p += 0.14;
    if (methodId === 'paypal' || methodId === 'venmo') p -= 0.12;
    if (methodId === 'paylater') p -= 0.06;
  } else if (tx.buyerProfile === 'new') {
    if (methodId === 'card') p += 0.04;
    if (methodId === 'paylater') p += 0.02;
  }

  if (tx.device === 'mobile') {
    if (methodId === 'venmo') p += 0.1;
    if (methodId === 'paypal') p += 0.03;
    if (methodId === 'card') p -= 0.06;
  } else {
    if (methodId === 'venmo') p -= 0.1;
    if (methodId === 'card') p += 0.03;
  }

  if (methodId === 'paylater') {
    if (tx.amount >= 500) p += 0.16;
    else if (tx.amount >= 150) p += 0.1;
    else if (tx.amount < 50) p -= 0.08;
  }
  if (tx.amount < 25 && (methodId === 'paypal' || methodId === 'venmo')) p += 0.03;
  if (tx.amount >= 1000 && methodId === 'card') p -= 0.05;

  return round2(Math.min(0.97, Math.max(0.05, p)));
}

function scoreFor(priority, c) {
  if (priority === 'fees') return -c.fee + c.conversion / 100; // conversion only breaks ties
  if (priority === 'conversion') return c.conversion;
  return c.expectedNet;
}

export function rankMethods(tx) {
  const candidates = METHOD_IDS.map((id) => {
    const { eligible, reason } = checkEligibility(id, tx);
    const fee = estimateFee(id, tx.amount);
    const conversion = estimateConversion(id, tx);
    const expectedNet = round2(conversion * (tx.amount - fee));
    return {
      id,
      label: METHODS[id].label,
      strengths: METHODS[id].strengths,
      eligible,
      reason,
      fee,
      conversion,
      expectedNet,
    };
  });

  for (const c of candidates) c.score = round4(scoreFor(tx.priority, c));

  const eligible = candidates.filter((c) => c.eligible).sort((a, b) => b.score - a.score);
  const ineligible = candidates.filter((c) => !c.eligible);
  eligible.forEach((c, i) => {
    c.rank = i + 1;
  });
  ineligible.forEach((c) => {
    c.rank = null;
  });

  return {
    transaction: tx,
    candidates: [...eligible, ...ineligible],
    recommended: eligible[0].id,
  };
}

export function rulesDecision(route, note) {
  const top = route.candidates.find((c) => c.id === route.recommended);
  const tx = route.transaction;
  const pct = Math.round(top.conversion * 100);
  const why = {
    net: `${top.label} has the best expected revenue: about ${pct}% of these buyers finish paying, so the order is worth about ${formatMoney(top.expectedNet, tx.currency)} after an estimated ${formatMoney(top.fee, tx.currency)} fee.`,
    fees: `${top.label} has the lowest estimated fee among available methods (${formatMoney(top.fee, tx.currency)}).`,
    conversion: `${top.label} gives this buyer the best chance of completing payment (about ${pct}%).`,
  }[tx.priority];

  return {
    fundingSource: top.id,
    confidence: null,
    reasoning: note ? `${why} ${note}` : why,
    decidedBy: 'rules',
    provider: null,
    model: null,
  };
}

export function formatMoney(value, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
