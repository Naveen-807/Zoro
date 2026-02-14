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
 * Build a horizontal bar chart showing cost breakdown for a command
 * (tool costs + settlement amount).
 */
export function buildSpendChartUrl(opts: {
    cmdId: string;
    items: Array<{ label: string; amountUsdc: number }>;
}): string {
    const { cmdId, items } = opts;
    const labels = items.map(i => i.label);
    const data = items.map(i => i.amountUsdc);
    const colors = items.map((_, idx) =>
        idx === items.length - 1 ? "rgba(59,130,246,0.8)" : "rgba(139,92,246,0.8)"
    );

    const config = {
        type: "horizontalBar" as const,
        data: {
            labels,
            datasets: [{
                label: "Cost (USDC)",
                data,
                backgroundColor: colors,
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            plugins: {
                title: {
                    display: true,
                    text: `${cmdId} — Spend Breakdown`,
                    color: "#333",
                    font: { size: 13, family: "Inter" }
                },
                legend: { display: false }
            },
            scales: {
                x: { ticks: { color: "#888", callback: (v: number) => `$${v}` }, grid: { color: "rgba(0,0,0,0.05)" } },
                y: { ticks: { color: "#555" }, grid: { display: false } }
            }
        }
    };

    const encoded = encodeURIComponent(JSON.stringify(config));
    return `https://quickchart.io/chart?c=${encoded}&w=500&h=220&bkg=white&f=png`;
}
