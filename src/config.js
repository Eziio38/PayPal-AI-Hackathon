// Reads configuration from environment variables.
// The app is sandbox-only on purpose: it never talks to PayPal's live API.

export const PAYPAL_SANDBOX_API = 'https://api-m.sandbox.paypal.com';

export function loadConfig(env = process.env) {
  const geminiKey = env.GEMINI_API_KEY || '';
  const anthropicKey = env.ANTHROPIC_API_KEY || '';

  let provider = (env.AI_PROVIDER || '').toLowerCase();
  if (!['gemini', 'anthropic', 'none'].includes(provider)) {
    provider = geminiKey ? 'gemini' : anthropicKey ? 'anthropic' : 'none';
  }
  if (provider === 'gemini' && !geminiKey) provider = 'none';
  if (provider === 'anthropic' && !anthropicKey) provider = 'none';

  return {
    port: Number(env.PORT) || 3000,
    brandName: env.BRAND_NAME || 'SmartPay Demo Store',
    paypal: {
      clientId: env.PAYPAL_CLIENT_ID || '',
      clientSecret: env.PAYPAL_CLIENT_SECRET || '',
      baseUrl: PAYPAL_SANDBOX_API,
    },
    ai: {
      provider,
      geminiKey,
      geminiModel: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
      anthropicKey,
      anthropicModel: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
      timeoutMs: Number(env.AI_TIMEOUT_MS) || 15000,
    },
    routeRateLimitPerMinute: Number(env.ROUTE_RATE_LIMIT) || 30,
  };
}
