// SmartPay-Routing AI server entry point.
import { loadConfig } from './src/config.js';
import { createPayPalClient } from './src/paypal.js';
import { createApp } from './src/app.js';

const config = loadConfig();
const paypal = createPayPalClient(config.paypal);
const app = createApp({ config, paypal });

app.listen(config.port, () => {
  const ai = config.ai.provider === 'none' ? 'off (rules engine only)' : config.ai.provider;
  console.log(`SmartPay-Routing AI listening on http://localhost:${config.port}`);
  console.log(`PayPal sandbox: ${paypal.isConfigured ? 'configured' : 'NOT configured'} | AI: ${ai}`);
});
