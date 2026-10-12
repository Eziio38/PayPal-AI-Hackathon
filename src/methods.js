// PayPal payment methods the router can lead checkout with.
// Each `id` is a PayPal JS SDK funding source (paypal.FUNDING.*).
//
// Fees and conversion rates below are ILLUSTRATIVE DEFAULTS for the demo.
// They are not PayPal's official pricing. Replace them with your own
// merchant rates and checkout analytics before relying on the output.

export const METHODS = {
  paypal: {
    id: 'paypal',
    label: 'PayPal',
    feePct: 3.49,
    feeFixed: 0.49,
    baseConversion: 0.74,
    strengths: 'One-tap checkout with saved details and buyer protection.',
  },
  paylater: {
    id: 'paylater',
    label: 'Pay Later',
    feePct: 3.49,
    feeFixed: 0.49,
    baseConversion: 0.68,
    strengths: 'Buyer pays in installments while the merchant is paid upfront.',
  },
  venmo: {
    id: 'venmo',
    label: 'Venmo',
    feePct: 3.49,
    feeFixed: 0.49,
    baseConversion: 0.7,
    strengths: 'Popular with US mobile shoppers who already use Venmo.',
  },
  card: {
    id: 'card',
    label: 'Debit or credit card',
    feePct: 2.99,
    feeFixed: 0.49,
    baseConversion: 0.64,
    strengths: 'Guest checkout through PayPal, no PayPal account needed.',
  },
};

export const METHOD_IDS = Object.keys(METHODS);

// Pay Later availability modeled for the demo: buyer country, currency and
// order amount range. PayPal's SDK makes the final eligibility call in the
// browser (see public/app.js), so this table only needs to be a good guess.
export const PAY_LATER_RULES = {
  US: { currency: 'USD', min: 30, max: 1500 },
  GB: { currency: 'GBP', min: 30, max: 2000 },
  FR: { currency: 'EUR', min: 30, max: 2000 },
};

export const CURRENCIES = ['USD', 'EUR', 'GBP'];

export const COUNTRIES = {
  US: 'United States',
  CA: 'Canada',
  GB: 'United Kingdom',
  FR: 'France',
  DE: 'Germany',
  ES: 'Spain',
  IT: 'Italy',
};

export const DEVICES = ['mobile', 'desktop'];

export const BUYER_PROFILES = {
  returning_paypal: 'Returning customer with a PayPal account',
  new: 'New customer',
  guest: 'Guest who does not want an account',
};

export const PRIORITIES = {
  net: 'Most revenue after fees',
  fees: 'Lowest fees',
  conversion: 'Highest chance the buyer completes payment',
};
