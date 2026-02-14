export function getBaseExplorerBaseUrl(chain: string): string {
  const normalized = chain.trim().toLowerCase();
  if (normalized === "base" || normalized === "base-mainnet" || normalized === "eip155:8453" || normalized === "8453") {
    return "https://basescan.org";
  }
  return "https://sepolia.basescan.org";
}

export function buildBaseTxExplorerUrl(chain: string, txHash: string): string {
  return `${getBaseExplorerBaseUrl(chain)}/tx/${txHash}`;
}

export function buildBaseAddressExplorerUrl(chain: string, address: string): string {
  return `${getBaseExplorerBaseUrl(chain)}/address/${address}`;
}
