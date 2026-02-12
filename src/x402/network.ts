export function toCaip2Network(chain: string): `eip155:${number}` {
  const normalized = chain.trim().toLowerCase();
  if (normalized.startsWith("eip155:")) {
    return normalized as `eip155:${number}`;
  }

  if (/^\d+$/.test(normalized)) {
    return `eip155:${Number(normalized)}` as `eip155:${number}`;
  }

  const mapping: Record<string, number> = {
    base: 8453,
    "base-mainnet": 8453,
    "base-sepolia": 84532,
    ethereum: 1,
    mainnet: 1,
    "ethereum-sepolia": 11155111
  };

  const chainId = mapping[normalized];
  if (!chainId) {
    throw new Error(`Unsupported chain "${chain}". Use a CAIP-2 network like eip155:84532.`);
  }

  return `eip155:${chainId}` as `eip155:${number}`;
}
