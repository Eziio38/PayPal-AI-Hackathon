// SmartPay Routing front end.
// 1. Sends the transaction to /api/route (rules engine + AI decision).
// 2. Shows every payment method as a lane, with the chosen one highlighted.
// 3. Renders the PayPal JS SDK button for the chosen funding source and
//    runs a real sandbox payment through /api/orders and /api/orders/:id/capture.

const $ = (sel) => document.querySelector(sel);

const PRESETS = [
  {
    label: 'Sneakers, US mobile',
    values: { item: 'Running sneakers', amount: 180, currency: 'USD', buyerCountry: 'US', device: 'mobile', buyerProfile: 'new', priority: 'net', notes: 'First-time visitor who came from an Instagram ad.' },
  },
  {
    label: 'Laptop, returning French buyer',
    values: { item: 'Ultrabook laptop', amount: 1299, currency: 'EUR', buyerCountry: 'FR', device: 'desktop', buyerProfile: 'returning_paypal', priority: 'net', notes: 'This customer abandoned the same cart twice at the payment step.' },
  },
  {
    label: 'Coffee refill, guest',
    values: { item: 'Coffee beans 500 g', amount: 14, currency: 'USD', buyerCountry: 'US', device: 'desktop', buyerProfile: 'guest', priority: 'fees', notes: 'Buys every month. Our margin on coffee is very thin.' },
  },
  {
    label: 'Office order, UK business',
    values: { item: 'Office chairs (4)', amount: 640, currency: 'GBP', buyerCountry: 'GB', device: 'desktop', buyerProfile: 'new', priority: 'net', notes: 'Company purchase. The buyer needs a VAT invoice and pays with a corporate card.' },
  },
];

const state = {
  config: null,
  current: null,
  renderToken: 0,
  sdkPromises: new Map(),
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.setAttribute('style', value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function money(value, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status}).`);
    error.data = data;
    error.status = res.status;
    throw error;
  }
  return data;
}

function methodLabel(id) {
  return state.config?.options.methods[id] || id;
}

function modelName(decision) {
  if (decision.provider === 'gemini') return `Gemini (${decision.model})`;
  if (decision.provider === 'anthropic') return `Claude (${decision.model})`;
  return decision.model || 'AI';
}

/* ---------- Setup ---------- */

function renderStatus(config) {
  const list = $('#status');
  list.replaceChildren(
    config.paypal.configured
      ? el('li', { class: 'on' }, 'PayPal sandbox ', el('strong', {}, 'connected'))
      : el('li', { class: 'off' }, 'PayPal sandbox ', el('strong', {}, 'not set up')),
    config.ai.provider !== 'none'
      ? el('li', { class: 'on' }, 'AI ', el('strong', {}, config.ai.model))
      : el('li', { class: 'off' }, 'AI ', el('strong', {}, 'off, rules only')),
  );
}

function fillSelect(select, entries) {
  select.replaceChildren(...entries.map(([value, label]) => el('option', { value }, label)));
}

function buildForm(config) {
  const { options } = config;
  fillSelect($('#currency'), options.currencies.map((c) => [c, c]));
  fillSelect($('#buyerCountry'), Object.entries(options.countries));
  fillSelect($('#buyerProfile'), Object.entries(options.buyerProfiles));
  $('#priority').replaceChildren(
    ...Object.entries(options.priorities).map(([value, label], i) =>
      el('label', {}, el('input', { type: 'radio', name: 'priority', value, checked: i === 0 }), el('span', {}, label)),
    ),
  );

  $('#presets').replaceChildren(
    ...PRESETS.map((preset, i) => {
      const button = el('button', { type: 'button', 'aria-pressed': 'false' }, preset.label);
      button.addEventListener('click', () => {
        applyPreset(i);
        routeCurrentForm();
      });
      return button;
    }),
  );
}

function applyPreset(index) {
  const form = $('#tx-form');
  const values = PRESETS[index].values;
  for (const [name, value] of Object.entries(values)) {
    // namedItem, not elements[name]: elements.item is a built-in method.
    const field = form.elements.namedItem(name);
    if (field) field.value = value;
  }
  document.querySelectorAll('#presets button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === index)));
}

/* ---------- Routing ---------- */

function readForm() {
  const form = $('#tx-form');
  const data = Object.fromEntries(new FormData(form).entries());
  return { ...data, amount: Number(data.amount) };
}

async function routeCurrentForm() {
  const button = $('#route-btn');
  const errorBox = $('#form-error');
  const form = $('#tx-form');
  errorBox.textContent = '';
  form.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));

  button.disabled = true;
  button.textContent = 'Routing…';
  try {
    const record = await api('/api/route', { method: 'POST', body: readForm() });
    state.current = record;
    renderResult(record);
    loadLog();
  } catch (err) {
    errorBox.textContent = err.message;
    const field = err.data?.field && form.elements.namedItem(err.data.field);
    if (field && field.setAttribute) {
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Route this payment';
  }
}

function renderResult(record) {
  const { decision, transaction: tx, candidates } = record;
  $('#empty-state').hidden = true;
  $('#result').hidden = false;

  const by = $('#decided-by');
  if (decision.decidedBy === 'ai') {
    const confidence = decision.confidence === null ? '' : `, ${Math.round(decision.confidence * 100)}% confident`;
    by.replaceChildren('Decided by ', el('strong', {}, modelName(decision)), confidence);
  } else {
    by.replaceChildren('Decided by the ', el('strong', {}, 'rules engine'));
  }

  $('#decision-title').textContent = `Lead with ${methodLabel(decision.fundingSource)}`;
  $('#decision-reason').textContent = decision.reasoning;
  $('#decision-diff').textContent =
    decision.decidedBy === 'ai'
      ? decision.agreesWithRules
        ? 'The rules engine reached the same choice.'
        : `The rules engine alone would have led with ${methodLabel(record.recommended)}. The AI changed it based on the context.`
      : '';

  const goal = state.config.options.priorities[tx.priority];
  $('#board-caption').textContent = `${money(tx.amount, tx.currency)} order, ranked for: ${goal.toLowerCase()}`;

  const maxNet = Math.max(...candidates.filter((c) => c.eligible).map((c) => c.expectedNet), 1);
  const lanes = candidates.map((c) => {
    const chosen = c.id === decision.fundingSource;
    const tag = chosen ? 'Leads checkout' : c.eligible ? `Rules rank ${c.rank}` : 'Not available';
    const name = el('div', { class: 'lane-name' }, el('strong', {}, c.label), el('span', { class: 'lane-tag' }, tag));
    if (!c.eligible) {
      return el('li', { class: 'lane blocked' }, name, el('p', { class: 'lane-reason' }, c.reason));
    }
    const fill = el('div', { class: 'fill' });
    requestAnimationFrame(() => {
      fill.style.width = `${Math.max(4, (c.expectedNet / maxNet) * 100)}%`;
    });
    return el(
      'li',
      { class: `lane${chosen ? ' chosen' : ''}` },
      name,
      el('div', { class: 'track', role: 'img', 'aria-label': `Expected revenue ${money(c.expectedNet, tx.currency)}` }, fill),
      el(
        'div',
        { class: 'lane-figures' },
        el('span', {}, 'Completes ', el('b', {}, `${Math.round(c.conversion * 100)}%`)),
        el('span', {}, 'Fee ', el('b', {}, money(c.fee, tx.currency))),
        el('span', { class: 'net' }, 'Expected ', el('b', {}, money(c.expectedNet, tx.currency))),
      ),
    );
  });
  $('#lanes').replaceChildren(...lanes);

  renderCheckout(record);
}

/* ---------- PayPal checkout ---------- */

function loadPayPalSdk(currency, buyerCountry) {
  const key = `${currency}_${buyerCountry}`;
  if (state.sdkPromises.has(key)) return state.sdkPromises.get(key);

  const namespace = `paypal_${key}`;
  const params = new URLSearchParams({
    'client-id': state.config.paypal.clientId,
    currency,
    intent: 'capture',
    components: 'buttons,funding-eligibility',
    'enable-funding': 'venmo,paylater',
    'buyer-country': buyerCountry, // sandbox only: simulates the buyer's country
  });

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?${params}`;
    script.dataset.namespace = namespace;
    script.async = true;
    script.onload = () => (window[namespace] ? resolve(window[namespace]) : reject(new Error('PayPal SDK did not initialise.')));
    script.onerror = () => reject(new Error('Could not load the PayPal SDK. Check PAYPAL_CLIENT_ID.'));
    document.head.append(script);
  });
  promise.catch(() => state.sdkPromises.delete(key));
  state.sdkPromises.set(key, promise);
  return promise;
}

function setCheckoutNote(text) {
  $('#checkout-note').textContent = text || '';
}

function buildButton(paypal, record, fundingSource) {
  return paypal.Buttons({
    fundingSource,
    style: { shape: 'rect', height: 44 },
    createOrder: async () => {
      const order = await api('/api/orders', { method: 'POST', body: { routeId: record.id, fundingSource } });
      return order.id;
    },
    onApprove: async (data, actions) => {
      try {
        const result = await api(`/api/orders/${encodeURIComponent(data.orderID)}/capture`, { method: 'POST' });
        showPayment(result, record);
        loadLog();
      } catch (err) {
        if (err.data?.issue === 'INSTRUMENT_DECLINED') return actions.restart();
        showPaymentError(err.message);
      }
      return undefined;
    },
    onCancel: () => setCheckoutNote('Payment cancelled. Nothing was charged.'),
    onError: (err) => {
      console.error(err);
      showPaymentError('PayPal could not complete the payment. Try again or choose another way to pay.');
    },
  });
}

async function renderCheckout(record) {
  const token = ++state.renderToken;
  const primary = $('#paypal-primary');
  const others = $('#paypal-others');
  const details = $('#other-options');
  primary.replaceChildren();
  others.replaceChildren();
  details.hidden = true;
  details.open = false;
  $('#payment-result').hidden = true;
  setCheckoutNote('');

  if (!state.config.paypal.configured) {
    setCheckoutNote('Sandbox checkout is off on this server. Add PayPal sandbox credentials (see README) to take a test payment.');
    return;
  }

  const tx = record.transaction;
  let paypal;
  try {
    setCheckoutNote('Loading PayPal…');
    paypal = await loadPayPalSdk(tx.currency, tx.buyerCountry);
  } catch (err) {
    if (token === state.renderToken) setCheckoutNote(err.message);
    return;
  }
  if (token !== state.renderToken) return;
  setCheckoutNote('');

  const chosen = record.decision.fundingSource;
  const ranked = record.candidates.filter((c) => c.eligible).map((c) => c.id);
  const order = [chosen, ...ranked.filter((id) => id !== chosen)];

  const buttons = order.map((id) => ({ id, button: buildButton(paypal, record, id) })).filter(({ button }) => button.isEligible());
  if (buttons.length === 0) {
    setCheckoutNote('PayPal has no payment method available for this buyer in this browser.');
    return;
  }

  const [lead, ...rest] = buttons;
  if (lead.id !== chosen) {
    setCheckoutNote(`${methodLabel(chosen)} isn't offered to this buyer in this browser, so ${methodLabel(lead.id)} leads instead.`);
  }

  await lead.button.render(primary);
  if (rest.length > 0) {
    details.hidden = false;
    for (const { button } of rest) {
      const slot = el('div');
      others.append(slot);
      await button.render(slot);
    }
  }
}

const PENDING_REASONS = {
  RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION:
    'The sandbox business account must accept payments in this currency. Accept it in the sandbox account, or set it to accept all currencies.',
  UNILATERAL: 'The merchant account is not confirmed in the sandbox.',
  PENDING_REVIEW: 'PayPal is reviewing the payment.',
};

function showPayment(result, record) {
  const box = $('#payment-result');
  const completed = result.status === 'COMPLETED' && result.captureStatus === 'COMPLETED';
  const amount = result.amount ? money(Number(result.amount.value), result.amount.currency_code) : money(record.transaction.amount, record.transaction.currency);

  box.className = `payment${completed ? '' : ' pending'}`;
  box.replaceChildren(
    el('h4', {}, completed ? `Paid ${amount} with ${methodLabel(result.fundingSource)}` : `Payment ${String(result.captureStatus || result.status).toLowerCase()}`),
    completed ? null : el('p', {}, PENDING_REASONS[result.pendingReason] || `PayPal status: ${result.pendingReason || result.status}.`),
    el(
      'dl',
      {},
      el('dt', {}, 'Order'),
      el('dd', {}, result.orderId),
      el('dt', {}, 'Capture'),
      el('dd', {}, result.captureId || 'n/a'),
      el('dt', {}, 'Method'),
      el('dd', {}, methodLabel(result.fundingSource)),
    ),
  );
  box.hidden = false;
  setCheckoutNote('');
}

function showPaymentError(message) {
  const box = $('#payment-result');
  box.className = 'payment failed';
  box.replaceChildren(el('h4', {}, 'Payment not completed'), el('p', {}, message));
  box.hidden = false;
}

/* ---------- Decision log ---------- */

async function loadLog() {
  const body = $('#log-body');
  try {
    const rows = await api('/api/decisions');
    if (rows.length === 0) {
      body.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'empty-row' }, 'Routed transactions will appear here.')));
      return;
    }
    body.replaceChildren(
      ...rows.map((r) => {
        const time = new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const outcome = r.outcome
          ? r.outcome.captureStatus === 'COMPLETED'
            ? el('span', { class: 'pill ok' }, 'Captured')
            : el('span', { class: 'pill warn' }, String(r.outcome.captureStatus || r.outcome.status).toLowerCase())
          : el('span', { class: 'pill' }, 'Not paid');
        return el(
          'tr',
          {},
          el('td', {}, time),
          el('td', {}, `${r.item}, ${money(r.amount, r.currency)}`),
          el('td', {}, `${r.buyerCountry}, ${r.device}`),
          el('td', {}, methodLabel(r.fundingSource)),
          el('td', {}, r.decidedBy === 'ai' ? r.model : 'Rules engine'),
          el('td', {}, outcome),
        );
      }),
    );
  } catch {
    body.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'empty-row' }, 'Could not load recent decisions.')));
  }
}

/* ---------- Boot ---------- */

async function init() {
  try {
    state.config = await api('/api/config');
  } catch (err) {
    $('#form-error').textContent = `Could not reach the server: ${err.message}`;
    return;
  }
  renderStatus(state.config);
  buildForm(state.config);
  applyPreset(0);
  $('#tx-form').addEventListener('submit', (event) => {
    event.preventDefault();
    document.querySelectorAll('#presets button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    routeCurrentForm();
  });
  loadLog();
}

init();
