import { createPublicClient, formatUnits, http, parseUnits } from "viem";
import { baseSepolia } from "viem/chains";

const QUOTER_V2_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" }
        ]
      }
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" }
    ]
  }
] as const;

const FACTORY_ABI = [
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" }
    ],
    outputs: [{ name: "pool", type: "address" }]
  }
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type UniswapQuote = {
  amountOutWeth: string;
  minOutWeth: string;
  feeTier: number;
  pool: string;
  gasEstimate: string;
};

export async function getUniswapQuote(args: {
  rpcUrl: string;
  quoterAddress: `0x${string}`;
  factoryAddress: `0x${string}`;
  usdcAddress: `0x${string}`;
  wethAddress: `0x${string}`;
  amountInUsdc: number;
  slippageBps: number;
}): Promise<UniswapQuote> {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(args.rpcUrl)
  });

  const amountIn = parseUnits(args.amountInUsdc.toString(), 6);
  const feeTiers: Array<500 | 3000 | 10000> = [500, 3000, 10000];

  let selectedFee: 500 | 3000 | 10000 | null = null;
  let selectedPool: string | null = null;

  for (const feeTier of feeTiers) {
    const pool = await client.readContract({
      address: args.factoryAddress,
      abi: FACTORY_ABI,
      functionName: "getPool",
      args: [args.usdcAddress, args.wethAddress, feeTier]
    });

    const poolAddress = String(pool);
    if (poolAddress.toLowerCase() !== ZERO_ADDRESS) {
      selectedFee = feeTier;
      selectedPool = poolAddress;
      break;
    }
  }

  if (!selectedFee || !selectedPool) {
    throw new Error("No Uniswap V3 USDC/WETH pool found on Base Sepolia");
  }

  const quoteResult = await client.readContract({
    address: args.quoterAddress,
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: args.usdcAddress,
        tokenOut: args.wethAddress,
        amountIn,
        fee: selectedFee,
        sqrtPriceLimitX96: 0n
      }
    ]
  });

  const amountOut = quoteResult[0] as bigint;
  const gasEstimate = quoteResult[3] as bigint;
  const minOut = (amountOut * BigInt(10_000 - args.slippageBps)) / 10_000n;

  return {
    amountOutWeth: formatUnits(amountOut, 18),
    minOutWeth: formatUnits(minOut, 18),
    feeTier: selectedFee,
    pool: selectedPool,
    gasEstimate: gasEstimate.toString()
  };
}
