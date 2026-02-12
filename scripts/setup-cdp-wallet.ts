import { getConfig } from "../src/config.js";
import { CdpWalletService } from "../src/x402/cdp.js";

async function main(): Promise<void> {
  const config = getConfig();
  const service = new CdpWalletService(config);
  const wallet = await service.getOrCreateWallet();
  const balances = await service.getBalances();

  console.log(JSON.stringify({
    wallet,
    balances,
    chain: config.X402_CHAIN
  }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
