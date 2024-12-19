/**
 * Auto Trader Plugin - Autonomous Trading Actions
 *
 * This module implements autonomous trading functionality for the GOAT plugin.
 * It handles trade execution, position management, and risk evaluation.
 */

import {
    type WalletClient,
    type Plugin,
    addParametersToDescription,
    type Tool,
    getTools,
} from "@goat-sdk/core";
import {
    type Action,
    generateText,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    composeContext,
    generateObjectV2,
    elizaLogger,
    stringToUuid
} from "@ai16z/eliza";
import { PublicKey, Keypair, Connection, VersionedTransaction } from "@solana/web3.js";
import { AutoClient } from "@ai16z/client-auto";
import { loadTokenAddresses } from "./tokenUtils";
import { TwitterClientInterface } from "@ai16z/client-twitter";
import { TokenProvider, ProcessedTokenData } from "@ai16z/plugin-solana";

/**
 * Safety limits and trading parameters
 */
const SAFETY_LIMITS = {
    MINIMUM_TRADE: 0.01,        // Minimum 0.01 SOL per trade
    MAX_POSITION_SIZE: 0.1,     // Maximum 10% of token liquidity
    MAX_SLIPPAGE: 0.05,        // Maximum 5% slippage allowed
    MIN_LIQUIDITY: 1000,       // Minimum $1000 liquidity required
    MIN_VOLUME: 2000,          // Minimum $2000 24h volume required
    MIN_TRUST_SCORE: 0.4,      // Minimum trust score to trade
    STOP_LOSS: 0.20,          // 20% stop loss trigger
    CHECK_INTERVAL: 5 * 60 * 1000,  // Check every 5 minutes
    TAKE_PROFIT: 0.12,         // Take profit at 12% gain
    TRAILING_STOP: 0.20,       // 20% trailing stop from highest
    PARTIAL_TAKE: 0.06,        // Take 50% profit at 6% gain
    REENTRY_DELAY: 60 * 60 * 1000, // Wait 1 hour before re-entering
    MAX_ACTIVE_POSITIONS: 5,    // Maximum concurrent positions
    MIN_WALLET_BALANCE: 0.05,   // Keep minimum 0.05 SOL in wallet
};

/**
 * Position tracking interface
 * Represents an open trading position
 */
interface Position {
    token: string;
    tokenAddress: string;             // Token symbol
    entryPrice: number;         // Entry price in USD
    amount: number;             // Position size
    timestamp: number;          // Entry timestamp
    sold?: boolean;             // Position closed flag
    exitPrice?: number;         // Exit price if sold
    exitTimestamp?: number;     // Exit timestamp if sold
    initialMetrics: {
        trustScore: number;     // Initial trust score
        volume24h: number;      // 24h volume at entry
        liquidity: { usd: number }; // Liquidity at entry
        riskLevel: "LOW" | "MEDIUM" | "HIGH";
    };
    highestPrice?: number;      // Highest price seen for trailing stop
    partialTakeProfit?: boolean; // Flag for partial profit taken
}

type GetOnChainActionsParams<TWalletClient extends WalletClient> = {
    wallet: TWalletClient;
    plugins: Plugin<TWalletClient>[];
    dexscreener: {
        watchlistUrl: string;
        chain: string;
        updateInterval: number;
    };
};

function createAction(tool: Tool): Action {
    return {
        name: tool.name,
        similes: [],
        description: tool.description,
        validate: async () => true,
        handler: async (runtime: IAgentRuntime, message: Memory, state: State | undefined, options?: Record<string, unknown>, callback?: HandlerCallback): Promise<boolean> => {
            try {
                let currentState = state ?? (await runtime.composeState(message));
                currentState = await runtime.updateRecentMessageState(currentState);
                const parameterContext = composeParameterContext(tool, currentState);
                const parameters = await generateParameters(runtime, parameterContext, tool);
                const parsedParameters = tool.parameters.safeParse(parameters);

                if (!parsedParameters.success) {
                    callback?.({ text: `Invalid parameters for action ${tool.name}: ${parsedParameters.error.message}`, content: { error: parsedParameters.error.message }});
                    return false;
                }

                const result = await tool.method(parsedParameters.data);
                const responseContext = composeResponseContext(tool, result, currentState);
                const response = await generateResponse(runtime, responseContext);
                callback?.({ text: response, content: result });
                return true;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                callback?.({ text: `Error executing action ${tool.name}: ${errorMessage}`, content: { error: errorMessage }});
                return false;
            }
        },
        examples: []
    };
}

function composeParameterContext(tool: Tool, state: State): string {
    return composeContext({
        state,
        template: `{{recentMessages}}\n\nGiven the recent messages, extract the following information for the action "${tool.name}":\n${addParametersToDescription("", tool.parameters)}`
    });
}

async function generateParameters(runtime: IAgentRuntime, context: string, tool: Tool): Promise<unknown> {
    const { object } = await generateObjectV2({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
        schema: tool.parameters,
    });
    return object;
}

function composeResponseContext(tool: Tool, result: unknown, state: State): string {
    return composeContext({
        state,
        template: `# Action Examples\n{{actionExamples}}\n\n# Knowledge\n{{knowledge}}\n\nThe action "${tool.name}" was executed successfully.\nResult: ${JSON.stringify(result)}\n\n{{recentMessages}}`
    });
}

async function generateResponse(runtime: IAgentRuntime, context: string): Promise<string> {
    return generateText({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
    });
}

// Update wallet validation
const validateWalletAddress = (address: string | undefined): boolean => {
    if (!address) return false;
    try {
        new PublicKey(address); // This will validate the base58 format
        return true;
    } catch {
        return false;
    }
};

// Add position tracking
const positions = new Map<string, Position>();

// Add position persistence
async function savePositions(runtime: IAgentRuntime): Promise<void> {
    try {
        const positionsArray = Array.from(positions.entries());
        await runtime.cacheManager.set("trading_positions", positionsArray);
        elizaLogger.log("Positions saved:", positionsArray);
    } catch (error) {
        elizaLogger.error("Error saving positions:", error);
    }
}

async function loadPositions(runtime: IAgentRuntime): Promise<void> {
    try {
        const savedPositions = await runtime.cacheManager.get<Array<[string, Position]>>("trading_positions");
        elizaLogger.log("Loading saved positions:", savedPositions);

        if (savedPositions) {
            positions.clear();
            for (const [key, position] of savedPositions) {
                positions.set(key, position);
            }
        }
    } catch (error) {
        elizaLogger.error("Error loading positions:", error);
    }
}

// Add sell action
const sellTokenAction: Action = {
    name: "SELL_TOKEN",
    description: "Sell a token position based on market conditions",
    similes: ["SELL", "EXIT_POSITION", "CLOSE_TRADE"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        try {
            const walletAddress = runtime.getSetting("WALLET_PUBLIC_KEY");
            return validateWalletAddress(walletAddress);
        } catch (error) {
            elizaLogger.error("Validation error:", error);
            return false;
        }
    },
    handler: async (runtime: IAgentRuntime, message: Memory, state: State | undefined, options?: Record<string, unknown>, callback?: HandlerCallback): Promise<boolean> => {
        try {
            const tokenAddress = options?.tokenAddress as string;
            if (!tokenAddress) {
                throw new Error("Token address required for sell action");
            }

            const position = positions.get(tokenAddress);
            if (!position) {
                throw new Error("No position found for this token");
            }

            // Execute sell
            const sellResult = { success: true }; // Implement actual sell logic

            if (sellResult.success) {
                position.sold = true;
                callback?.({
                    text: `🔴 Position closed: ${position.token}\nAmount: $${position.amount.toFixed(2)}`,
                    content: {
                        action: "SELL_TOKEN",
                        position
                    }
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Sell error:", error);
            return false;
        }
    }
};


// Add helper function for selling
async function sellPosition(
    position: Position,
    currentPrice: number,
    runtime: IAgentRuntime,
    sellType: 'TAKE_PROFIT' | 'PARTIAL_TAKE' | 'TRAILING_STOP' | 'STOP_LOSS' = 'STOP_LOSS'
): Promise<boolean> {
    try {
        elizaLogger.log("Attempting to sell position:", {
            token: position.token,
            tokenAddress: position.tokenAddress,
            amount: position.amount,
            currentPrice
        });

        // Execute sell by swapping from token to SOL
        const tradeResult = await executeTrade(runtime, {
            tokenAddress: position.tokenAddress,
            amount: position.amount,
            slippage: SAFETY_LIMITS.MAX_SLIPPAGE,
            isSell: true
        });

        // Log trade result
        elizaLogger.log("Sell trade result:", {
            success: tradeResult.success,
            token: position.token,
            tokenAddress: position.tokenAddress,
            result: tradeResult
        });

        if (tradeResult.success) {
            position.sold = true;
            position.exitPrice = currentPrice;
            position.exitTimestamp = Date.now();

            const pnl = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

            // Customize tweet based on sell type
            const emoji = pnl >= 0 ? '🟢' : '🔴';
            let tweetPrefix = '';
            switch (sellType) {
                case 'TAKE_PROFIT':
                    tweetPrefix = `${emoji} Take Profit`;
                    break;
                case 'PARTIAL_TAKE':
                    tweetPrefix = `${emoji} Partial Take Profit`;
                    break;
                case 'TRAILING_STOP':
                    tweetPrefix = `${emoji} Trailing Stop`;
                    break;
                case 'STOP_LOSS':
                    tweetPrefix = `${emoji} Stop Loss`;
                    break;
            }

            await tweetTradeUpdate(runtime, {
                action: 'SELL',
                token: position.token,
                amount: position.amount,
                price: currentPrice,
                signature: tradeResult.signature,
                pnl,
                sellType: tweetPrefix
            });
        }

        return tradeResult.success;
    } catch (error) {
        elizaLogger.error(`Failed to sell position ${position.token}:`, error);
        return false;
    }
}

// Add trust evaluation function
async function evaluateTrust(runtime: IAgentRuntime, pair: any): Promise<number>{
    try {
        // Calculate trust score from metrics
        const metrics = {
            liquidity: pair.liquidity?.usd || 0,
            volume24h: pair.volume?.h24 || 0,
            marketCap: pair.marketCap || 0
        };

        // Calculate component scores
        const liquidityScore = Math.min(metrics.liquidity / SAFETY_LIMITS.MIN_LIQUIDITY, 1) * 0.4;
        const volumeScore = Math.min(metrics.volume24h / SAFETY_LIMITS.MIN_VOLUME, 1) * 0.4;
        const marketCapScore = Math.min(metrics.marketCap / 1000000, 1) * 0.2;

        // Calculate final score
        const trustScore = Math.min(liquidityScore + volumeScore + marketCapScore, 1);

        elizaLogger.log("Trust evaluation:", {
            token: pair.baseToken.symbol,
            metrics,
            scores: {
                liquidity: liquidityScore,
                volume: volumeScore,
                marketCap: marketCapScore,
                total: trustScore
            }
        });

        return trustScore;
    } catch (error) {
        elizaLogger.error(`Trust evaluation error for ${pair.baseToken.symbol}:`, error);
        return 0;
    }
}
/**
 * Autonomous trading action
 * Monitors market conditions and executes trades automatically
 */
const autonomousTradeAction: Action = {
    name: "AUTONOMOUS_TRADE",
    description: "Execute autonomous trades based on market conditions",
    similes: ["TRADE", "AUTO_TRADE", "TRADE_SOLANA", "TRADE_SOL", "AUTONOMOUS"],
    examples: [],
    autoStart: true,
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        try {
            if (message.content?.source === "auto") {
                return true;
            }
            const walletAddress = runtime.getSetting("WALLET_PUBLIC_KEY");
            return validateWalletAddress(walletAddress);
        } catch (error) {
            elizaLogger.error("Validation error:", error);
            return false;
        }
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        options?: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            const walletAddress = runtime.getSetting("WALLET_PUBLIC_KEY");
            if (!validateWalletAddress(walletAddress)) {
                throw new Error("Invalid wallet configuration");
            }

            elizaLogger.log("Starting autonomous trade monitoring...");

            // Start periodic trading checks
            const startTrading = async () => {
                try {
                    elizaLogger.log("Starting trading cycle...");

                    // Load saved positions first
                    await loadPositions(runtime);

                    // Get token addresses and fetch data
                    const tokenAddresses = loadTokenAddresses();
                    const tokensUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddresses.join(',')}`;
                    elizaLogger.log("Fetching DexScreener data from:", tokensUrl);

                    const data = await fetchDexScreenerData(tokensUrl);
                    if (!data.pairs || !data.pairs.length) {
                        elizaLogger.warn("No pairs found in DexScreener response");
                        return;
                    }

                    // Get unique pairs
                    const uniquePairs = filterUniquePairs(data.pairs);
                    elizaLogger.log(`Processing ${uniquePairs.length} pairs...`);

                    // First monitor existing positions
                    await monitorExistingPositions(uniquePairs, runtime, callback);

                    // Then look for new opportunities
                    await evaluateNewTrades(uniquePairs, runtime, callback);

                    // Save updated positions
                    await savePositions(runtime);

                    // Log current state
                    elizaLogger.log("Current positions:", {
                        count: positions.size,
                        positions: Array.from(positions.entries())
                    });

                } catch (error) {
                    elizaLogger.error("Trading cycle error:", error);
                }
            };

            // Start periodic checks with stored ID
            const intervalId = setInterval(startTrading, SAFETY_LIMITS.CHECK_INTERVAL);

            // Store just the numeric ID
            await runtime.cacheManager.set("trading_interval_id", intervalId[Symbol.toPrimitive]());

            // Execute initial check
            await startTrading();

            callback?.({
                text: "🤖 Autonomous trading started. Monitoring market conditions...",
                content: {
                    action: "AUTONOMOUS_TRADE",
                    status: "started",
                    interval: SAFETY_LIMITS.CHECK_INTERVAL
                }
            });

            return true;

        } catch (error) {
            elizaLogger.error("Autonomous trade error:", error);
            callback?.({
                text: 'Trading error: ${error.message}',
                content: { error: error.message }
            });
            return false;
        }
    },
    cleanup: async (runtime: IAgentRuntime) => {
        const intervalId = await runtime.cacheManager.get<number>("trading_interval_id");
        if (intervalId) {
            clearInterval(intervalId);
        }
    }
};

// Add RPC fallbacks and retry logic
const RPC_ENDPOINTS = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-api.projectserum.com",
    "https://rpc.ankr.com/solana"
];

async function getConnection(runtime: IAgentRuntime, retryCount = 0): Promise<Connection> {
    const customRpc = runtime.getSetting("RPC_URL");
    const endpoints = customRpc ? [customRpc, ...RPC_ENDPOINTS] : RPC_ENDPOINTS;

    try {
        const endpoint = endpoints[retryCount % endpoints.length];
        const connection = new Connection(endpoint, 'confirmed');

        // Test connection
        await connection.getLatestBlockhash();
        return connection;
    } catch (error) {
        if (retryCount < endpoints.length * 2) { // Try each endpoint twice
            elizaLogger.warn(`RPC connection failed, trying next endpoint (attempt ${retryCount + 1})`);
            return getConnection(runtime, retryCount + 1);
        }
        throw error;
    }
}

/**
 * Executes a trade with the given parameters
 * @param runtime Agent runtime environment
 * @param params Trade parameters (token, amount, slippage)
 * @returns Trade result with success/failure and details
 */
async function executeTrade(
    runtime: IAgentRuntime,
    params: {
        tokenAddress: string;
        amount: number;
        slippage: number;
        isSell?: boolean;
    },
    retryCount = 0
): Promise<any> {
    try {
        elizaLogger.log("Executing trade with params:", params);

        const SOL_ADDRESS = "So11111111111111111111111111111111111111112";

        // Set input/output based on trade direction
        const inputMint = params.isSell ? params.tokenAddress : SOL_ADDRESS;
        const outputMint = params.isSell ? SOL_ADDRESS : params.tokenAddress;

        // Convert amount to lamports/smallest unit
        const adjustedAmount = Math.floor(params.amount * 1e9);

        elizaLogger.log("Fetching quote with params:", {
            inputMint,
            outputMint,
            amount: adjustedAmount
        });

        // Validate minimum amount
        if (!params.isSell && params.amount < SAFETY_LIMITS.MINIMUM_TRADE) {
            elizaLogger.warn("Trade amount too small:", {
                amount: params.amount,
                minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE
            });
            return {
                success: false,
                error: "Trade amount too small",
                details: {
                    amount: params.amount,
                    minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE
                }
            };
        }

        const walletKeypair = getWalletKeypair(runtime);
        const connection = await getConnection(runtime);

        // Setup swap parameters
        const solAddress = "So11111111111111111111111111111111111111112"; // SOL

        // For sells, swap from token to SOL. For buys, swap from SOL to token
        const inputTokenCA = params.isSell ? params.tokenAddress : solAddress;
        const outputTokenCA = params.isSell ? solAddress : params.tokenAddress;
        const swapAmount = Math.floor(params.amount * 1e9);

        elizaLogger.log("Trade execution details:", {
            isSell: params.isSell,
            inputToken: inputTokenCA,
            outputToken: outputTokenCA,
            amount: params.amount,
            slippage: params.slippage
        });

        // Get quote
        const quoteResponse = await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${swapAmount}&slippageBps=${Math.floor(params.slippage * 10000)}`
        );

        if (!quoteResponse.ok) {
            const error = await quoteResponse.text();
            elizaLogger.warn("Quote request failed:", {
                status: quoteResponse.status,
                error
            });
            return {
                success: false,
                error: "Failed to get quote",
                details: { status: quoteResponse.status, error }
            };
        }

        const quoteData = await quoteResponse.json();
        if (!quoteData || quoteData.error) {
            elizaLogger.warn("Invalid quote data:", quoteData);
            return {
                success: false,
                error: "Invalid quote data",
                details: quoteData
            };
        }

        elizaLogger.log("Quote received:", quoteData);

        // Get swap transaction
        const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                quoteResponse: quoteData,
                userPublicKey: walletKeypair.publicKey.toString(),
                wrapAndUnwrapSol: true,
                computeUnitPriceMicroLamports: 2000000,
                dynamicComputeUnitLimit: true
            })
        });

        const swapData = await swapResponse.json();
        if (!swapData?.swapTransaction) {
            throw new Error("No swap transaction returned");
        }

        elizaLogger.log("Swap transaction received");

        // Deserialize transaction
        const transactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const tx = VersionedTransaction.deserialize(transactionBuf);

        // Get fresh blockhash and sign transaction
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        tx.message.recentBlockhash = blockhash;
        tx.sign([walletKeypair]);

        // Send with confirmation
        const signature = await connection.sendTransaction(tx, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3
        });

        // Wait for confirmation
        const confirmation = await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight
        });

        if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${confirmation.value.err}`);
        }

        return { success: true, signature, confirmation };

    } catch (error) {
        // Handle blockhash errors with retry
        if (
            error.message?.includes("Blockhash not found") &&
            retryCount < 3
        ) {
            elizaLogger.warn(`Blockhash error, retrying (${retryCount + 1}/3)...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return executeTrade(runtime, params, retryCount + 1);
        }

        elizaLogger.error("Trade execution failed:", {
            error: error instanceof Error ? error.message : error,
            stack: error instanceof Error ? error.stack : undefined,
            params,
            retryCount
        });

        return {
            success: false,
            error: error.message || error,
            recoverable: error.message?.includes("Blockhash not found")
        };
    }
}

/**
 * Helper function to fetch and validate DexScreener data
 * @param url DexScreener API endpoint URL
 * @returns Parsed DexScreener response data
 * @throws Error if fetch fails or response is invalid
 */
async function fetchDexScreenerData(url: string) {
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0' // Some APIs require a user agent
            }
        });

        // Check if response is OK
        if (!response.ok) {
            throw new Error(`DexScreener API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (!data || !data.pairs) {
            throw new Error("Invalid response format from DexScreener");
        }

        elizaLogger.log("DexScreener data fetched successfully:", {
            pairsCount: data.pairs.length,
            schemaVersion: data.schemaVersion
        });

        return data;
    } catch (error) {
        elizaLogger.error("DexScreener API error:", error);
        elizaLogger.error("Failed URL:", url);
        throw new Error(`Failed to fetch DexScreener data: ${error.message}`);
    }
}

/**
 * Gets wallet keypair from runtime settings
 * @param runtime Agent runtime environment
 * @returns Solana keypair for transactions
 * @throws Error if private key is missing or invalid
 */
function getWalletKeypair(runtime: IAgentRuntime): Keypair {
    const privateKeyString = runtime.getSetting("WALLET_PRIVATE_KEY");
    if (!privateKeyString) {
        throw new Error("No wallet private key configured");
    }

    try {
        const privateKeyBytes = decodeBase58(privateKeyString);
        return Keypair.fromSecretKey(privateKeyBytes);
    } catch (error) {
        elizaLogger.error("Failed to create wallet keypair:", error);
        throw error;
    }
}

/**
 * Gets current SOL balance for wallet
 * @param runtime Agent runtime environment
 * @returns Balance in SOL
 */
async function getWalletBalance(runtime: IAgentRuntime): Promise<number> {
    try {
        const walletKeypair = getWalletKeypair(runtime);
        const walletPubKey = walletKeypair.publicKey;

        // Fetch balance from RPC
        const connection = new Connection(
            runtime.getSetting("RPC_URL") || "https://api.mainnet-beta.solana.com"
        );

        const balance = await connection.getBalance(walletPubKey);
        const solBalance = balance / 1e9; // Convert lamports to SOL

        elizaLogger.log("Fetched wallet balance:", {
            address: walletPubKey.toBase58(),
            lamports: balance,
            sol: solBalance
        });

        return solBalance;
    } catch (error) {
        elizaLogger.error("Failed to get wallet balance:", error);
        return 0;
    }
}

/**
 * Filters and deduplicates token pairs by liquidity
 * @param pairs Array of token pairs from DexScreener
 * @returns Array of unique pairs with highest liquidity
 */
function filterUniquePairs(pairs: any[]): any[] {
    // Create a map to store best pair for each token
    const bestPairs = new Map();

    for (const pair of pairs) {
        const tokenAddress = pair.baseToken?.address;
        if (!tokenAddress) continue;

        // Get existing best pair for this token
        const existingPair = bestPairs.get(tokenAddress);

        // If no existing pair or this pair has better liquidity, update
        if (!existingPair || (pair.liquidity?.usd || 0) > (existingPair.liquidity?.usd || 0)) {
            bestPairs.set(tokenAddress, pair);
        }
    }

    return Array.from(bestPairs.values());
}

/**
 * Gets on-chain actions for the GOAT plugin
 * @param params Plugin parameters including wallet and DEX settings
 * @returns Array of available trading actions
 */
export async function getOnChainActions<TWalletClient extends WalletClient>({
    wallet,
    plugins,
    dexscreener
}: GetOnChainActionsParams<TWalletClient>): Promise<Action[]> {
    const tools = await getTools<TWalletClient>({
        wallet,
        plugins,
        wordForTool: "action",
    });

    // Create base actions
    const baseActions = tools.map(tool => createAction(tool));

    // Add autonomous trade action
    const allActions = [...baseActions, autonomousTradeAction, sellTokenAction];

    // Log registered actions
    allActions.forEach(action => {
        elizaLogger.log(`Registering action: ${action.name}`);
    });

    // Auto-start autonomous trading
    if (typeof AutoClient !== 'undefined' && AutoClient.isAutoClient) {
        elizaLogger.log("Auto-starting autonomous trading...");
        try {
            await autonomousTradeAction.handler(
                (AutoClient as any).runtime,
                { content: { source: "auto" } } as Memory,
                undefined,
                undefined,
                (response) => elizaLogger.log("Auto-trade response:", response)
            );
        } catch (error) {
            elizaLogger.error("Failed to auto-start trading:", error);
        }
    }

    return allActions;
}

// Add helper to decode base58 private key
function decodeBase58(str: string): Uint8Array {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const ALPHABET_MAP = new Map(ALPHABET.split('').map((c, i) => [c, BigInt(i)]));

    let result = BigInt(0);
    for (const char of str) {
        const value = ALPHABET_MAP.get(char);
        if (value === undefined) throw new Error('Invalid base58 character');
        result = result * BigInt(58) + value;
    }

    const bytes = [];
    while (result > 0n) {
        bytes.unshift(Number(result & 0xffn));
        result = result >> 8n;
    }

    // Add leading zeros
    for (let i = 0; i < str.length && str[i] === '1'; i++) {
        bytes.unshift(0);
    }

    return new Uint8Array(bytes);
}

// Add at the top with other constants
let cachedTwitterClient: typeof TwitterClientInterface | null = null;

// Modify tweetTradeUpdate to use cached client
async function tweetTradeUpdate(
    runtime: IAgentRuntime,
    params: {
        action: 'BUY' | 'SELL';
        token: string;
        amount: number;
        price: number;
        signature: string;
        pnl?: number;
        sellType?: string;
    }
): Promise<void> {
    try {
        const { action, token, amount, price, signature, pnl } = params;
        const explorerUrl = `https://solscan.io/tx/${signature}`;

        // Format tweet content
        let content = '';
        if (action === 'BUY') {
            content = `🤖 Bought $${token}\n💰 ${amount.toFixed(3)} SOL @ $${price.toFixed(6)}\n🔗 tx: ${explorerUrl}`;
        } else {
            content = `${params.sellType || (pnl && pnl > 0 ? '🟢' : '🔴')} Sold $${token}\n💰 ${amount.toFixed(3)} SOL @ $${price.toFixed(6)}\n📈 PnL: ${pnl?.toFixed(2)}%\n🔗 tx: ${explorerUrl}`;
        }

        elizaLogger.log("Posting trade update:", content);

        // Use cached client or initialize new one
        if (!cachedTwitterClient) {
            cachedTwitterClient = await TwitterClientInterface.start(runtime);
        }

        if (!cachedTwitterClient) {
            throw new Error("Failed to initialize Twitter client");
        }

        const response = await cachedTwitterClient.post.client.twitterClient.sendTweet(content);
        elizaLogger.log("Trade tweet posted successfully:", response);

    } catch (error) {
        elizaLogger.error("Failed to tweet trade update:", {
            error: error instanceof Error ? error.message : error,
            params
        });
    }
}

// Helper function to monitor existing positions
async function monitorExistingPositions(
    pairs: any[],
    runtime: IAgentRuntime,
    callback?: HandlerCallback
): Promise<void> {
    elizaLogger.log("Starting position monitoring...");
    elizaLogger.log("Current positions:", Array.from(positions.entries()));

    for (const pair of pairs) {
        try {
            if (!validateWalletAddress(pair.baseToken?.address)) {
                elizaLogger.log(`Skipping invalid token address: ${pair.baseToken?.address}`);
                continue;
            }

            const currentPosition = positions.get(pair.baseToken.address);
            elizaLogger.log(`Checking position for ${pair.baseToken.symbol}:`, {
                hasPosition: !!currentPosition,
                isSold: currentPosition?.sold,
                position: currentPosition
            });

            if (!currentPosition || currentPosition.sold) {
                continue;
            }

            // Add token analysis before sell decisions
            elizaLogger.log(`Analyzing token before sell decision...`);
            const tokenAnalysis = await analyzeToken(runtime, pair.baseToken.address);
            elizaLogger.log(`Token analysis for ${pair.baseToken.symbol}:`, tokenAnalysis);

            const currentPrice = Number(pair.priceUsd);
            const positionSize = currentPosition.amount;

            // Log position metrics
            elizaLogger.log(`Position metrics for ${pair.baseToken.symbol}:`, {
                currentPrice,
                entryPrice: currentPosition.entryPrice,
                positionSize,
                highestPrice: currentPosition.highestPrice
            });

            // Monitor existing position
            const priceChange = (currentPrice - currentPosition.entryPrice) / currentPosition.entryPrice;
            elizaLogger.log(`Price change for ${pair.baseToken.symbol}: ${(priceChange * 100).toFixed(2)}%`);

            // Take full profit check
            if (priceChange >= SAFETY_LIMITS.TAKE_PROFIT) {
                elizaLogger.log(`Take profit triggered for ${currentPosition.token}:`, {
                    priceChange: priceChange * 100,
                    threshold: SAFETY_LIMITS.TAKE_PROFIT * 100
                });
                await sellPosition({
                    ...currentPosition,
                    tokenAddress: pair.baseToken.address,
                    amount: positionSize
                }, currentPrice, runtime, 'TAKE_PROFIT');
                continue;
            }

            // Partial profit check
            if (priceChange >= SAFETY_LIMITS.PARTIAL_TAKE && !currentPosition.partialTakeProfit) {
                elizaLogger.log(`Partial take profit triggered for ${currentPosition.token}:`, {
                    priceChange: priceChange * 100,
                    threshold: SAFETY_LIMITS.PARTIAL_TAKE * 100
                });
                const halfPositionSize = positionSize * 0.5;
                await sellPosition({
                    ...currentPosition,
                    tokenAddress: pair.baseToken.address,
                    amount: halfPositionSize
                }, currentPrice, runtime, 'PARTIAL_TAKE');
                currentPosition.amount *= 0.5;
                currentPosition.partialTakeProfit = true;
                continue;
            }

            // Trailing stop check
            if (currentPrice > (currentPosition.highestPrice || 0)) {
                elizaLogger.log(`New highest price for ${currentPosition.token}: ${currentPrice}`);
                currentPosition.highestPrice = currentPrice;
            }

            const dropFromHigh = ((currentPosition.highestPrice || currentPrice) - currentPrice) / (currentPosition.highestPrice || currentPrice);
            elizaLogger.log(`Drop from high for ${currentPosition.token}: ${(dropFromHigh * 100).toFixed(2)}%`);

            if (dropFromHigh >= SAFETY_LIMITS.TRAILING_STOP) {
                elizaLogger.log(`Trailing stop triggered for ${currentPosition.token}:`, {
                    dropFromHigh: dropFromHigh * 100,
                    threshold: SAFETY_LIMITS.TRAILING_STOP * 100
                });
                await sellPosition({
                    ...currentPosition,
                    tokenAddress: pair.baseToken.address,
                    amount: positionSize
                }, currentPrice, runtime, 'TRAILING_STOP');
                continue;
            }

            // Stop loss check
            const priceDrop = (currentPosition.entryPrice - currentPrice) / currentPosition.entryPrice;
            elizaLogger.log(`Price drop for ${currentPosition.token}: ${(priceDrop * 100).toFixed(2)}%`);

            if (priceDrop > SAFETY_LIMITS.STOP_LOSS) {
                elizaLogger.log(`Stop loss triggered for ${currentPosition.token}:`, {
                    priceDrop: priceDrop * 100,
                    threshold: SAFETY_LIMITS.STOP_LOSS * 100
                });
                const sellResult = await sellPosition({
                    ...currentPosition,
                    tokenAddress: pair.baseToken.address,
                    amount: positionSize
                }, currentPrice, runtime, 'STOP_LOSS');

                if (sellResult) {
                    elizaLogger.log(`Successfully sold ${currentPosition.token} at stop loss`);
                    if (callback) {
                        callback({
                            text: `🔴 Stop loss triggered: Sold ${currentPosition.token}\nEntry: $${currentPosition.entryPrice.toFixed(6)}\nExit: $${currentPrice.toFixed(6)}\nLoss: ${(priceDrop * 100).toFixed(2)}%`,
                            content: {
                                action: "STOP_LOSS",
                                token: currentPosition.token,
                                entryPrice: currentPosition.entryPrice,
                                exitPrice: currentPrice,
                                loss: priceDrop
                            }
                        });
                    }
                }
                continue;
            }

            // Inside monitorExistingPositions, add this logging
            elizaLogger.log(`Position analysis for ${pair.baseToken.symbol}:`, {
                currentPrice,
                entryPrice: currentPosition.entryPrice,
                highestPrice: currentPosition.highestPrice,
                priceChange: (priceChange * 100).toFixed(2) + '%',
                dropFromHigh: (dropFromHigh * 100).toFixed(2) + '%',
                triggers: {
                    takeProfit: SAFETY_LIMITS.TAKE_PROFIT * 100 + '%',
                    partialTake: SAFETY_LIMITS.PARTIAL_TAKE * 100 + '%',
                    trailingStop: SAFETY_LIMITS.TRAILING_STOP * 100 + '%',
                    stopLoss: SAFETY_LIMITS.STOP_LOSS * 100 + '%'
                }
            });

        } catch (error) {
            elizaLogger.error(`Error monitoring position for ${pair.baseToken?.symbol}:`, error);
        }
    }
    elizaLogger.log("Position monitoring completed");
}

// Helper function to evaluate new trades
async function evaluateNewTrades(
    pairs: any[],
    runtime: IAgentRuntime,
    callback?: HandlerCallback
): Promise<void> {
    for (const pair of pairs) {
        try {
            if (!validateWalletAddress(pair.baseToken?.address)) {
                continue;
            }

            // Skip if we have an active position
            const currentPosition = positions.get(pair.baseToken.address);
            if (currentPosition && !currentPosition.sold) {
                continue;
            }

            // Get wallet balance
            const balance = await getWalletBalance(runtime);

            // Calculate position size for new trades
            const positionSize = Math.min(
                (pair.liquidity?.usd || 0) * SAFETY_LIMITS.MAX_POSITION_SIZE,
                balance * 0.1
            );

            // Skip if position size too small
            if (positionSize < SAFETY_LIMITS.MINIMUM_TRADE) {
                elizaLogger.warn("Skipping trade - position size too small:", {
                    calculatedSize: positionSize,
                    minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE,
                    token: pair.baseToken.symbol
                });
                continue;
            }

            // Skip if liquidity too low
            if ((pair.liquidity?.usd || 0) < SAFETY_LIMITS.MIN_LIQUIDITY) {
                elizaLogger.warn(`Skipping trade - low liquidity for ${pair.baseToken.symbol}: ${pair.liquidity?.usd || 0}`);
                continue;
            }

            // Skip if volume too low
            if ((pair.volume?.h24 || 0) < SAFETY_LIMITS.MIN_VOLUME) {
                elizaLogger.warn(`Skipping trade - low volume for ${pair.baseToken.symbol}: ${pair.volume?.h24 || 0}`);
                continue;
            }

            // Calculate trust score
            const trustScore = await evaluateTrust(runtime, pair);

            // Skip if trust score too low
            if (trustScore < SAFETY_LIMITS.MIN_TRUST_SCORE) {
                elizaLogger.warn(`Low trust score for ${pair.baseToken.symbol}: ${trustScore}`);
                continue;
            }

            // Add token analysis before trade
            elizaLogger.log(`Analyzing token before trade...`);
            const tokenAnalysis = await analyzeToken(runtime, pair.baseToken.address);
            elizaLogger.log(`Token analysis for ${pair.baseToken.symbol}:`, tokenAnalysis);

            elizaLogger.log(`Attempting to buy ${pair.baseToken.symbol}:`, {
                positionSize,
                price: pair.priceUsd,
                trustScore,
                tokenAnalysis
            });

            // Execute buy trade
            const tradeResult = await executeTrade(runtime, {
                tokenAddress: pair.baseToken.address,
                amount: positionSize,
                slippage: SAFETY_LIMITS.MAX_SLIPPAGE
            });

            if (tradeResult.success) {
                // Track new position
                positions.set(pair.baseToken.address, {
                    token: pair.baseToken.symbol,
                    tokenAddress: pair.baseToken.address,
                    entryPrice: Number(pair.priceUsd),
                    amount: positionSize,
                    timestamp: Date.now(),
                    initialMetrics: {
                        trustScore,
                        volume24h: pair.volume?.h24 || 0,
                        liquidity: { usd: pair.liquidity?.usd || 0 },
                        riskLevel: trustScore > 0.8 ? "LOW" : trustScore > 0.5 ? "MEDIUM" : "HIGH"
                    }
                });

                // Save positions immediately after update
                await savePositions(runtime);

                if (callback) {
                    callback({
                        text: `🤖 Trade executed: ${pair.baseToken.symbol}\nAmount: $${positionSize.toFixed(2)}\nPrice: $${Number(pair.priceUsd).toFixed(6)}`,
                        content: {
                            ...tradeResult,
                            symbol: pair.baseToken.symbol,
                            amount: positionSize,
                            price: pair.priceUsd,
                            position: positions.get(pair.baseToken.address)
                        }
                    });
                }

                // Tweet the trade
                await tweetTradeUpdate(runtime, {
                    action: 'BUY',
                    token: pair.baseToken.symbol,
                    amount: positionSize,
                    price: Number(pair.priceUsd),
                    signature: tradeResult.signature
                });
            } else {
                elizaLogger.warn(`Trade failed for ${pair.baseToken.symbol}:`, tradeResult);
            }
        } catch (error) {
            elizaLogger.error(`Error evaluating trade for ${pair.baseToken?.symbol}:`, {
                error: error instanceof Error ? error.message : error,
                stack: error instanceof Error ? error.stack : undefined
            });
        }
    }
}

interface TokenData extends ProcessedTokenData {
    tokenSecurityData: {
        ownerBalance: string;
        creatorBalance: string;
        ownerPercentage: number;
        top10HolderPercent: number;
    };
    tradeData: {
        unique_wallet_30m: number;
        unique_wallet_history_30m: number;
        unique_wallet_30m_change_percent: number;
        unique_wallet_1h: number;
        unique_wallet_history_1h: number;
        unique_wallet_1h_change_percent: number;
        unique_wallet_24h: number;
        unique_wallet_history_24h: number;
        unique_wallet_24h_change_percent: number;
    };
}

interface TokenAnalysis {
    security: {
        ownerBalance: string;
        creatorBalance: string;
        ownerPercentage: number;
        top10HolderPercent: number;
    };
    trading: {
        price: number;
        priceChange24h: number;
        volume24h: number;
        uniqueWallets24h: number;
        walletChanges: {
            unique_wallet_30m_change_percent: number;
            unique_wallet_1h_change_percent: number;
            unique_wallet_24h_change_percent: number;
        };
    };
    market: {
        liquidity: number;
        marketCap: number;
        fdv: number;
    };
}

async function analyzeToken(runtime: IAgentRuntime, tokenAddress: string): Promise<TokenAnalysis | null> {
    try {
        const tokenProvider = new TokenProvider(tokenAddress, null, runtime.cacheManager);

        // Get processed data with error handling
        const processedData = await tokenProvider.getProcessedTokenData().catch(() => ({
            tokenSecurityData: {
                ownerBalance: '0',
                creatorBalance: '0',
                ownerPercentage: 0,
                top10HolderPercent: 0
            },
            tradeData: null,
            dexScreenerData: { pairs: [] }
        } as TokenData));

        // Use DexScreener data for analysis since trade data might be null
        const dexPair = processedData?.dexScreenerData?.pairs?.[0];

        const analysis = {
            security: {
                ownerBalance: processedData?.tokenSecurityData?.ownerBalance || '0',
                creatorBalance: processedData?.tokenSecurityData?.creatorBalance || '0',
                ownerPercentage: processedData?.tokenSecurityData?.ownerPercentage || 0,
                top10HolderPercent: processedData?.tokenSecurityData?.top10HolderPercent || 0
            },
            trading: {
                price: dexPair?.priceUsd || 0,
                priceChange24h: dexPair?.priceChange?.h24 || 0,
                volume24h: dexPair?.volume?.h24 || 0,
                uniqueWallets24h: processedData?.tradeData?.unique_wallet_24h || 0,
                walletChanges: {
                    unique_wallet_30m_change_percent: 0,
                    unique_wallet_1h_change_percent: 0,
                    unique_wallet_24h_change_percent: 0
                }
            },
            market: {
                liquidity: dexPair?.liquidity?.usd || 0,
                marketCap: dexPair?.marketCap || 0,
                fdv: dexPair?.fdv || 0
            }
        };

        elizaLogger.log(`Token Analysis for ${tokenAddress}:`, analysis);
        return analysis;
    } catch (error) {
        elizaLogger.error(`Failed to analyze token ${tokenAddress}:`, error);
        return null;
    }
}
