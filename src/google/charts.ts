/**
 * Generate chart image URLs using QuickChart.io (free, no API key).
 * These URLs can be inserted into Google Docs via the insertInlineImage API.
 */

export function buildPriceChartUrl(opts: {
    token: string;
    prices: number[];
    labels: string[];
    currentPrice: number;
    change24h: string;
}): string {
    const { token, prices, labels, currentPrice, change24h } = opts;
    const isPositive = !change24h.startsWith("-");
    const lineColor = isPositive ? "rgba(0,214,143,1)" : "rgba(255,71,87,1)";
    const fillColor = isPositive ? "rgba(0,214,143,0.15)" : "rgba(255,71,87,0.15)";

    const config = {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: `${token}/USDC — $${currentPrice.toFixed(2)} (${change24h})`,
                    data: prices,
                    borderColor: lineColor,
                    backgroundColor: fillColor,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    borderWidth: 2
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                title: {
                    display: true,
                    text: `${token} Price — Last 24h`,
                    color: "#333",
                    font: { size: 14, family: "Inter" }
                },
                legend: { display: true, labels: { color: "#555", font: { size: 10 } } }
            },
            scales: {
                x: { ticks: { color: "#888", maxTicksLimit: 6 }, grid: { display: false } },
                y: { ticks: { color: "#888", callback: (v: number) => `$${v}` }, grid: { color: "rgba(0,0,0,0.05)" } }
            }
        }
    };

    const encoded = encodeURIComponent(JSON.stringify(config));
    return `https://quickchart.io/chart?c=${encoded}&w=600&h=300&bkg=white&f=png`;
}

/**
 * Generate simulated 24h price data for a token.
 * Uses deterministic seed for consistent results within the same hour.
 */
export function generateSimulatedPriceData(token: string, basePrice: number): {
    prices: number[];
    labels: string[];
} {
    const now = new Date();
    const prices: number[] = [];
    const labels: string[] = [];

    for (let i = 23; i >= 0; i--) {
        const t = new Date(now.getTime() - i * 3600_000);
        labels.push(`${t.getUTCHours().toString().padStart(2, "0")}:00`);

        // Deterministic variation based on token + hour
        const seed = hashCode(`${token}:${t.toISOString().slice(0, 13)}`);
        const variance = ((seed % 400) - 200) / 10000; // ±2%
        prices.push(Number((basePrice * (1 + variance)).toFixed(2)));
    }

    return { prices, labels };
}

function hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
}
