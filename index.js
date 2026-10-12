const paymentNetworks = [
    { name: "PayPal_Direct", fee_percentage: 1.5, speed_ms: 200, reliability: 99.9 },
    { name: "Standard_ACH", fee_percentage: 0.5, speed_ms: 5000, reliability: 98.0 },
    { name: "Crypto_Stablecoin", fee_percentage: 0.1, speed_ms: 1200, reliability: 99.0 }
];

function determineBestRoute(amount, requiresInstant) {
    console.log(`Analyzing best payment route for $${amount}...`);
    let bestRoute = paymentNetworks[0]; 
    let bestScore = -1;
    for (const net of paymentNetworks) {
        if (requiresInstant && net.speed_ms > 1000) continue;
        const score = (100 - net.fee_percentage) * (net.reliability / 100);
        if (score > bestScore) {
            bestScore = score;
            bestRoute = net;
        }
    }
    return bestRoute;
}
const amountToProcess = 500;
const route = determineBestRoute(amountToProcess, true);
console.log(`[AI Decision] Route selected: ${route.name} (Fee: ${route.fee_percentage}%)`);
