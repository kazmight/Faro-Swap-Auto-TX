require('dotenv').config();
const { ethers } = require('ethers');
const readline = require('readline-sync'); // For manual input

// --- Basic Logger (for demonstration) ---
const logger = {
    info: (...args) => console.log(`[INFO] ${new Date().toLocaleString()}:`, ...args),
    warn: (...args) => console.warn(`[WARN] ${new Date().toLocaleString()}:`, ...args),
    error: (...args) => console.error(`[ERROR] ${new Date().toLocaleString()}:`, ...args),
    debug: (...args) => console.log(`[DEBUG] ${new Date().toLocaleString()}:`, ...args),
};

// --- Configuration ---
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
    logger.error("Error: PRIVATE_KEY not found in .env file. Please add it.");
    process.exit(1);
}

const PHAROS_TESTNET_RPC_URL = 'https://testnet.dplabs-internal.com';
const CHAIN_ID = 688688; // Pharos Testnet Chain ID

// Contract Addresses
const USDT_TOKEN_ADDRESS = '0xed59de2d7ad9c043442e381231ee3646fc3c2939';
const USDC_TOKEN_ADDRESS = '0xad902cf99c2de2f1ba5ec4d642fd7e49cae9ee37';
const WPHRS_TOKEN_ADDRESS = '0x76aaada469d23216be5f7c596fa25f282ff9b364'; // Wrapped Native Token (WETH equivalent)
const UNIVERSAL_ROUTER_ADDRESS = '0x1d416077dc5a9721d4f7a57f2cbccb0e65d8373e'; // Position Manager / Universal Router

// Token Decimals
const tokenDecimals = {
    WPHRS: 18,
    USDC: 6,
    USDT: 6,
};

// Token Address Mapping (using your symbols)
const tokenAddressMap = {
    WPHRS: WPHRS_TOKEN_ADDRESS,
    USDC: USDC_TOKEN_ADDRESS,
    USDT: USDT_TOKEN_ADDRESS,
    PHRS: WPHRS_TOKEN_ADDRESS // Treat PHRS as WPHRS for mapping, but handle native for value transfer
};

// --- Your Provided Options ---
const pairOptions = [
    { id: 1, from: 'WPHRS', to: 'USDC', amount: 0.0001 },
    { id: 2, from: 'WPHRS', to: 'USDT', amount: 0.0001 },
    { id: 3, from: 'USDC', to: 'WPHRS', amount: 0.0001 },
    { id: 4, from: 'USDT', to: 'WPHRS', amount: 0.0001 },
    { id: 5, from: 'USDC', to: 'USDT', amount: 0.0001 },
    { id: 6, from: 'USDT', to: 'USDC', amount: 0.0001 },
];

const lpOptions = [
    { id: 1, token0: 'WPHRS', token1: 'USDC', amount0: 0.0001, amount1: 0.0001, fee: 3000 },
    { id: 2, token0: 'WPHRS', token1: 'USDT', amount0: 0.0001, amount1: 0.0001, fee: 3000 },
];

// --- ABIs ---
// Combined Universal Router ABI for multicall and specific swap functions (if supported)
const UNIVERSAL_ROUTER_ABI = [
    {
        inputs: [
            { internalType: 'uint256', name: 'collectionAndSelfcalls', type: 'uint256' },
            { internalType: 'bytes[]', name: 'data', type: 'bytes[]' },
        ],
        name: 'multicall',
        outputs: [],
        stateMutability: 'payable', // Multicall can be payable for native token operations
        type: 'function',
    },
    // Adding `exactInputSingle` and `exactInput` for V3 if directly callable (not just via multicall)
    // You'd need to confirm if these are directly exposed or only callable via multicall
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
    "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
    // Also include V2-like swaps if those are still present on the router:
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
    "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
    "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",

    // Add Universal Router specific commands if available and needed (e.g. from their source code or ABI)
    // These are placeholders/examples based on common Universal Router command IDs
    "function wrapETH(address recipient, uint256 amountOutMinimum) payable",
    "function unwrapWETH(address recipient, uint256 amountOutMinimum) payable",
];

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) public returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function deposit() public payable', // WETH deposit (for wrapping native token)
    'function withdraw(uint256 wad) public', // WETH withdraw (for unwrapping native token)
];

const POSITION_MANAGER_ABI = [
    {
        inputs: [
            {
                components: [
                    { internalType: 'address', name: 'token0', type: 'address' },
                    { internalType: 'address', name: 'token1', type: 'address' },
                    { internalType: 'uint24', name: 'fee', type: 'uint24' },
                    { internalType: 'int24', name: 'tickLower', type: 'int24' },
                    { internalType: 'int24', name: 'tickUpper', type: 'int24' },
                    { internalType: 'uint256', name: 'amount0Desired', type: 'uint256' },
                    { internalType: 'uint256', name: 'amount1Desired', type: 'uint256' },
                    { internalType: 'uint256', name: 'amount0Min', type: 'uint256' },
                    { internalType: 'uint256', name: 'amount1Min', type: 'uint256' },
                    { internalType: 'address', name: 'recipient', type: 'address' },
                    { internalType: 'uint256', name: 'deadline', type: 'uint256' },
                ],
                internalType: 'struct INonfungiblePositionManager.MintParams',
                name: 'params',
                type: 'tuple',
            },
        ],
        name: 'mint',
        outputs: [
            { internalType: 'uint256', name: 'tokenId', type: 'uint256' },
            { internalType: 'uint128', name: 'liquidity', type: 'uint128' },
            { internalType: 'uint256', name: 'amount0', type: 'uint256' },
            { internalType: 'uint256', name: 'amount1', type: 'uint256' },
        ],
        stateMutability: 'payable',
        type: 'function',
    },
    "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)"
];

// --- Setup Provider and Wallet ---
const provider = new ethers.JsonRpcProvider(PHAROS_TESTNET_RPC_URL, {
    chainId: CHAIN_ID,
    name: 'Pharos Testnet'
});
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

logger.info(`Connected with wallet address: ${wallet.address}`);

// --- Core Utility Functions ---

// Function to wait for transaction receipt with retry logic
const waitForTransactionWithRetry = async (provider, txHash, maxRetries = 10, baseDelayMs = 2000) => {
    let retries = 0;
    while (retries < maxRetries) {
        try {
            const receipt = await provider.getTransactionReceipt(txHash);
            if (receipt && receipt.blockNumber) {
                logger.info(`Transaction ${txHash} confirmed in block ${receipt.blockNumber}. Status: ${receipt.status === 1 ? 'Success' : 'Failed'}`);
                if (receipt.status === 0) {
                    throw new Error(`Transaction ${txHash} failed on-chain.`);
                }
                return receipt;
            }
            logger.warn(`Transaction receipt not found for ${txHash}, retrying (${retries + 1}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.pow(2, retries)));
            retries++;
        } catch (error) {
            if (error.code === 'TRANSACTION_REPLACED' || error.code === 'TIMEOUT' || error.code === -32008) {
                logger.warn(`RPC error for ${txHash} (${error.code}), retrying (${retries + 1}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.pow(2, retries)));
                retries++;
            } else {
                logger.error(`Unhandled error fetching transaction receipt for ${txHash}: ${error.message}`);
                throw error;
            }
        }
    }
    throw new Error(`Failed to get transaction receipt for ${txHash} after ${maxRetries} retries`);
};

// Function to get manual delay from user
const getManualDelay = (prompt, defaultValue) => {
    let delay = parseInt(readline.question(prompt + ` (default: ${defaultValue}s): `));
    if (isNaN(delay) || delay < 0) {
        logger.warn(`Invalid input. Using default delay of ${defaultValue} seconds.`);
        return defaultValue * 1000; // Return in milliseconds
    }
    return delay * 1000; // Convert to milliseconds
};

// Helper to get token contract
async function getTokenContract(tokenSymbol) {
    const address = tokenAddressMap[tokenSymbol];
    if (!address) {
        throw new Error(`Unknown token symbol: ${tokenSymbol}`);
    }
    return new ethers.Contract(address, ERC20_ABI, wallet);
}

// Approve token function (now also using waitForTransactionWithRetry)
async function approveToken(tokenSymbol, spenderAddress, amountToApprove) {
    try {
        const tokenContract = await getTokenContract(tokenSymbol);
        const ownerAddress = await wallet.getAddress();
        const currentAllowance = await tokenContract.allowance(ownerAddress, spenderAddress);
        const tokenDec = tokenDecimals[tokenSymbol];

        if (currentAllowance >= amountToApprove) {
            logger.info(`Allowance for ${tokenSymbol} already sufficient (${ethers.formatUnits(currentAllowance, tokenDec)}).`);
            return true;
        }

        logger.info(`Approving ${ethers.formatUnits(amountToApprove, tokenDec)} ${tokenSymbol} for ${spenderAddress}...`);
        const tx = await tokenContract.approve(spenderAddress, amountToApprove);
        logger.info(`Approval transaction sent: ${tx.hash}`);
        await waitForTransactionWithRetry(provider, tx.hash);
        logger.info(`Approval for ${tokenSymbol} successful!`);
        return true;
    } catch (error) {
        logger.error(`Error approving ${tokenSymbol}: ${error.message}`);
        return false;
    }
}

// Function to check token balance and approval
const checkBalanceAndApproval = async (wallet, tokenSymbol, amount, spenderAddress) => {
    try {
        // Native token (PHRS) balance check (assuming WPHRS represents PHRS for user input)
        if (tokenSymbol === 'WPHRS') {
            const nativeBalance = await provider.getBalance(wallet.address);
            const requiredNative = ethers.parseEther(amount.toString());
            if (nativeBalance < requiredNative) {
                logger.warn(`Skipping: Insufficient PHRS balance. Have: ${ethers.formatEther(nativeBalance)}, Need: ${amount}`);
                return false;
            }
            // No approval needed for native token when sent as value
            return true;
        }

        // ERC-20 token balance and approval check
        const tokenContract = await getTokenContract(tokenSymbol);
        const balance = await tokenContract.balanceOf(wallet.address);
        const decimals = tokenDecimals[tokenSymbol];
        const required = ethers.parseUnits(amount.toString(), decimals);

        if (balance < required) {
            logger.warn(`Skipping: Insufficient ${tokenSymbol} balance. Have: ${ethers.formatUnits(balance, decimals)}, Need: ${amount}`);
            return false;
        }

        // Check allowance for ERC-20 tokens only
        const allowance = await tokenContract.allowance(wallet.address, spenderAddress); // New constant allowance
        if (allowance < required) {
            logger.warn(`Allowance for ${tokenSymbol} is insufficient. Current: ${ethers.formatUnits(allowance, decimals)}, Required: ${amount}`);
            const approved = await approveToken(tokenSymbol, spenderAddress, ethers.MaxUint256); // Approve max
            if (!approved) {
                logger.error(`Failed to get sufficient approval for ${tokenSymbol}.`);
                return false;
            }
        }
        return true; // Balance is sufficient and approval is set (or not needed)
    } catch (error) {
        logger.error(`Error in checkBalanceAndApproval for ${tokenSymbol}: ${error.message}`);
        return false;
    }
};

// --- Universal Router Multicall Data Encoding (Based on Uniswap Universal Router) ---
// COMMAND IDs (These are Uniswap Universal Router specific, Faroswap might differ!)
const Commands = {
    V3_SWAP_EXACT_IN: '0x00', // Example command ID
    WRAP_NATIVE_TOKEN: '0x05', // Example command ID
    UNWRAP_WETH: '0x06', // Example command ID
    // Add other command IDs as needed from Faroswap's Universal Router
};

// Interface for encoding function calls
const routerInterface = new ethers.Interface(UNIVERSAL_ROUTER_ABI);

const getMulticallData = (pair, amount, walletAddress, slippage = 0.005) => {
    const commands = [];
    const inputs = [];
    let value = BigInt(0); // Value to send with multicall (for native token)

    const fromTokenAddress = tokenAddressMap[pair.from];
    const toTokenAddress = tokenAddressMap[pair.to];
    const parsedAmountIn = ethers.parseUnits(amount.toString(), tokenDecimals[pair.from]);

    // --- IMPORTANT: Calculate amountOutMin dynamically using a price oracle or router.getAmountsOut ---
    // For now, using a placeholder for amountOutMin. This is highly risky in production.
    const amountOutMin = BigInt(0); // Placeholder, REPLACE THIS!

    // Handle wrapping native token (PHRS) to WPHRS if `from` is PHRS/WPHRS
    if (pair.from === 'WPHRS') {
        // If the swap path starts with native token, we must first wrap it.
        // Assuming Universal Router has a WRAP_NATIVE_TOKEN command
        commands.push(Commands.WRAP_NATIVE_TOKEN);
        inputs.push(routerInterface.encodeFunctionData("wrapETH", [walletAddress, 0])); // recipient, amountOutMinimum
        value = parsedAmountIn; // Send PHRS as value
    }

    // Main swap command
    commands.push(Commands.V3_SWAP_EXACT_IN); // Assuming V3 swap for now
    inputs.push(
        routerInterface.encodeFunctionData("exactInputSingle", [ // Using exactInputSingle as an example
            {
                tokenIn: fromTokenAddress,
                tokenOut: toTokenAddress,
                fee: 3000, // IMPORTANT: Get the correct fee tier for the pool! (e.g., 3000 for 0.3%)
                recipient: walletAddress,
                deadline: Math.floor(Date.now() / 1000) + 60 * 20,
                amountIn: parsedAmountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0 // Optional: Set to 0 for no limit
            }
        ])
    );

    // Handle unwrapping WPHRS to native token (PHRS) if `to` is PHRS/WPHRS
    if (pair.to === 'WPHRS') {
        commands.push(Commands.UNWRAP_WETH);
        inputs.push(routerInterface.encodeFunctionData("unwrapWETH", [walletAddress, amountOutMin])); // recipient, amountOutMinimum
    }

    // Encode the final multicall transaction
    const multicallData = routerInterface.encodeFunctionData("multicall", [
        // The first argument `collectionAndSelfcalls` is specific to the Universal Router.
        // It's a bitmask indicating which commands to collect/selfcall.
        // For simple sequential calls without complex logic, often 0 is sufficient,
        // but verify Faroswap's exact implementation.
        0, // Placeholder: This might need to be adjusted based on Faroswap's router logic
        inputs
    ]);

    return { multicallData, value };
};

// --- Swaps and Liquidity Functions ---

async function addLiquidityV3(token0Symbol, token1Symbol, amount0, amount1, feeTier, slippage = 0.005) {
    try {
        const positionManager = new ethers.Contract(UNIVERSAL_ROUTER_ADDRESS, POSITION_MANAGER_ABI, wallet);
        const token0Address = tokenAddressMap[token0Symbol];
        const token1Address = tokenAddressMap[token1Symbol];

        const parsedAmount0 = ethers.parseUnits(amount0.toString(), tokenDecimals[token0Symbol]);
        const parsedAmount1 = ethers.parseUnits(amount1.toString(), tokenDecimals[token1Symbol]);

        // Check balances and approvals before proceeding
        const canProceed0 = await checkBalanceAndApproval(wallet, token0Symbol, amount0, UNIVERSAL_ROUTER_ADDRESS);
        const canProceed1 = await checkBalanceAndApproval(wallet, token1Symbol, amount1, UNIVERSAL_ROUTER_ADDRESS);

        if (!canProceed0 || !canProceed1) {
            logger.warn(`Skipping Add Liquidity for ${token0Symbol}/${token1Symbol} due to insufficient balance or approval.`);
            return;
        }

        // Sort tokens for Uniswap V3
        const { token0: sortedToken0Address, token1: sortedToken1Address } = getSortedTokens(token0Address, token1Address);

        // --- IMPORTANT: Tick Calculation (Using full range for simplicity on testnet) ---
        const tickLower = -887272; // Uniswap V3 MIN_TICK
        const tickUpper = 887272; // Uniswap V3 MAX_TICK

        // Calculate min amounts with slippage
        const amount0Min = parsedAmount0 - (parsedAmount0 * BigInt(Math.round(slippage * 10000))) / BigInt(10000);
        const amount1Min = parsedAmount1 - (parsedAmount1 * BigInt(Math.round(slippage * 10000))) / BigInt(10000);

        const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now

        logger.info(`\nAdding liquidity for ${token0Symbol}/${token1Symbol} (Fee: ${feeTier / 10000}%)...`);
        logger.info(`Desired ${token0Symbol}: ${amount0}, Desired ${token1Symbol}: ${amount1}`);
        logger.info(`Tick Range: [${tickLower}, ${tickUpper}]`);

        const params = {
            token0: sortedToken0Address,
            token1: sortedToken1Address,
            fee: feeTier,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: parsedAmount0,
            amount1Desired: parsedAmount1,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            recipient: wallet.address,
            deadline: deadline,
        };

        let ethValue = BigInt(0);
        // If WPHRS is involved, send its equivalent native token amount as msg.value
        if (token0Symbol === 'WPHRS' || token1Symbol === 'WPHRS') {
            if (token0Symbol === 'WPHRS') {
                ethValue = parsedAmount0;
            } else {
                ethValue = parsedAmount1;
            }
            logger.info(`Sending ${ethers.formatEther(ethValue)} PHRS as value with transaction.`);
        }

        const tx = await positionManager.mint(params, {
            value: ethValue,
            gasLimit: 1500000
        });
        logger.info(`Add Liquidity (V3) transaction sent: ${tx.hash}`);
        const receipt = await waitForTransactionWithRetry(provider, tx.hash);

        const mintEvent = receipt.logs.find(log => {
            try {
                return positionManager.interface.parseLog(log)?.name === 'Mint';
            } catch (e) {
                return false;
            }
        });
        if (mintEvent) {
             logger.info(`Minted Token ID: ${mintEvent.args.tokenId}`);
             logger.info(`Liquidity: ${mintEvent.args.liquidity}`);
        } else {
            logger.warn("Could not find Mint event in transaction receipt.");
        }
        logger.info(`Add Liquidity (V3) successful! Transaction Hash: ${tx.hash}`);

    } catch (error) {
        logger.error("Error adding liquidity (V3):", error);
        throw error;
    }
}

async function performSwap(pair, delayMs) { // `pair` object directly passed
    try {
        const router = new ethers.Contract(UNIVERSAL_ROUTER_ADDRESS, UNIVERSAL_ROUTER_ABI, wallet);

        // Check balance and approval for the `from` token
        const canProceed = await checkBalanceAndApproval(wallet, pair.from, pair.amount, UNIVERSAL_ROUTER_ADDRESS);
        if (!canProceed) {
            logger.warn(`Skipping Swap ID ${pair.id} from ${pair.from} to ${pair.to} due to insufficient balance or approval.`);
            return;
        }

        logger.info(`\nSwapping ${pair.amount} ${pair.from} for ${pair.to} (ID: ${pair.id})...`);

        // Get multicall data
        const { multicallData, value } = getMulticallData(pair, pair.amount, wallet.address);

        const tx = await router.multicall(0, [multicallData], { // Adjust `collectionAndSelfcalls` if needed
            value: value, // Send native token as value if wrapping
            gasLimit: 1000000 // Adjust gas limit for multicall swap
        });
        logger.info(`Swap transaction sent: ${tx.hash}`);
        await waitForTransactionWithRetry(provider, tx.hash);
        logger.info(`Swap ID ${pair.id} successful! Transaction Hash: ${tx.hash}`);

        // Introduce delay between transactions
        if (delayMs > 0) {
            logger.info(`Waiting for ${delayMs / 1000} seconds before next transaction...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

    } catch (error) {
        logger.error(`Error performing swap ID ${pair.id}: ${error.message}`);
        throw error;
    }
}

async function main() {
    try {
        logger.info("\n--- Starting Automated Operations on Faroswap (V3-like) ---");

        const delayBetweenTx = getManualDelay('Enter delay BETWEEN each transaction in seconds', 20);
        const verificationDelay = getManualDelay('Enter delay for API VERIFICATION in seconds', 10);

        // --- Manual Mode Selector ---
        const operationChoice = readline.question(
            "\nChoose operation:\n" +
            "1. Run all Swaps\n" +
            "2. Run all Add Liquidity\n" +
            "3. Run all Swaps AND all Add Liquidity\n" +
            "Enter choice (1/2/3): "
        );

        let runSwaps = false;
        let runAddLiquidity = false;

        if (operationChoice === '1') {
            runSwaps = true;
        } else if (operationChoice === '2') {
            runAddLiquidity = true;
        } else if (operationChoice === '3') {
            runSwaps = true;
            runAddLiquidity = true;
        } else {
            logger.error("Invalid choice. Exiting.");
            return;
        }

        // --- Execute Swaps from pairOptions (if chosen) ---
        if (runSwaps) {
            logger.info("\n*** Executing Swaps ***");
            for (const pair of pairOptions) {
                logger.info(`\n--- Attempting Swap ID: ${pair.id} (${pair.from} to ${pair.to}) ---`);
                try {
                    await performSwap(pair, delayBetweenTx);
                } catch (error) {
                    logger.error(`Failed to execute swap ID ${pair.id}. Moving to next operation.`);
                }
                await new Promise(resolve => setTimeout(resolve, verificationDelay)); // Delay after each operation for API verification
            }
        }

        // --- Execute Add Liquidity from lpOptions (if chosen) ---
        if (runAddLiquidity) {
            logger.info("\n*** Executing Add Liquidity ***");
            for (const lp of lpOptions) {
                logger.info(`\n--- Attempting LP ID: ${lp.id} (${lp.token0}/${lp.token1}) ---`);
                try {
                    await addLiquidityV3(lp.token0, lp.token1, lp.amount0, lp.amount1, lp.fee);
                } catch (error) {
                    logger.error(`Failed to add liquidity ID ${lp.id}. Moving to next operation.`);
                }
                await new Promise(resolve => setTimeout(resolve, verificationDelay)); // Delay after each operation for API verification
            }
        }

        logger.info("\n--- Automated Operations Completed ---");

    } catch (error) {
        logger.error("Fatal error in main execution:", error);
    } finally {
        // Ensure readline-sync doesn't keep process open if not needed
        // readline.close(); // readline-sync doesn't have a close method
    }
}

main().catch(error => logger.error("Unhandled error in main execution:", error));
