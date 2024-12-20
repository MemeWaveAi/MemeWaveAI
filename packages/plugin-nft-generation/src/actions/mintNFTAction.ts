import {
    Action,
    composeContext,
    Content,
    elizaLogger,
    generateObjectDeprecated,
    getEmbeddingZeroVector,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    stringToUuid,
} from "@ai16z/eliza";
import { createNFT } from "../handlers/createNFT.ts";
import { verifyNFT } from "../handlers/verifyNFT.ts";
import { sleep } from "../index.ts";
import WalletSolana from "../provider/wallet/walletSolana.ts";
import { PublicKey } from "@solana/web3.js";

const mintTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "collectionAddress": "D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS",
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested mint nft:
- collection contract address

Respond with a JSON markdown block containing only the extracted values.

Note: Make sure to extract the collection address from the most recent messages whenever possible.`


export interface MintContent extends Content {
    collectionAddress: string;
}

function isMintNFTContent(
    runtime: IAgentRuntime,
    content: any
): content is MintContent {
    console.log("Content for mint", content);
    return typeof content.collectionAddress === "string";
}

const mintNFTAction: Action = {
    name: "MINT_NFT",
    similes: [
        "NFT_MINTING",
        "NFT_CREATION",
        "CREATE_NFT",
        "GENERATE_NFT",
        "MINT_TOKEN",
        "CREATE_TOKEN",
        "MAKE_NFT",
        "TOKEN_GENERATION",
    ],
    description: "Mint NFTs for the collection",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const AwsAccessKeyIdOk = !!runtime.getSetting("AWS_ACCESS_KEY_ID");
        const AwsSecretAccessKeyOk = !!runtime.getSetting(
            "AWS_SECRET_ACCESS_KEY"
        );
        const AwsRegionOk = !!runtime.getSetting("AWS_REGION");
        const AwsS3BucketOk = !!runtime.getSetting("AWS_S3_BUCKET");

        return (
            AwsAccessKeyIdOk ||
            AwsSecretAccessKeyOk ||
            AwsRegionOk ||
            AwsS3BucketOk
        );
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: { [key: string]: unknown },
        callback: HandlerCallback
    ) => {
        try {
            elizaLogger.log("Composing state for message:", message);
            const userId = runtime.agentId;
            const agentName = runtime.character.name;
            const roomId = stringToUuid("nft_generate_room-" + agentName);

            // const memory: Memory = {
            //     agentId: userId,
            //     userId,
            //     roomId,
            //     content: {
            //         text: message.content.text,
            //         source: "nft-generator",
            //     },
            //     createdAt: Date.now(),
            //     embedding: getEmbeddingZeroVector(),
            // };
            // const state = await runtime.composeState(memory, {
            //     message: message.content.text,
            // });
            if (!state) {
                state = (await runtime.composeState(message)) as State;
            } else {
                state = await runtime.updateRecentMessageState(state);
            }

            // Compose transfer context
            const transferContext = composeContext({
                state,
                template: mintTemplate,
            });

            const content = await generateObjectDeprecated({
                runtime,
                context: transferContext,
                modelClass: ModelClass.LARGE,
            });

            elizaLogger.log("generateObjectDeprecated:", transferContext);

            if (!isMintNFTContent(runtime, content)) {
                elizaLogger.error("Invalid content for MINT_NFT action.");
                if (callback) {
                    callback({
                        text: "Unable to process mint request. Invalid content provided.",
                        content: { error: "Invalid mint content" },
                    });
                }
                return false;
            }

            elizaLogger.log("mint content", content);

            const publicKey = runtime.getSetting("SOLANA_PUBLIC_KEY");
            const privateKey = runtime.getSetting("SOLANA_PRIVATE_KEY");

            const wallet = new WalletSolana(
                new PublicKey(publicKey),
                privateKey
            );

            const collectionInfo = await wallet.fetchDigitalAsset(
                content.collectionAddress
            );
            elizaLogger.log("Collection Info", collectionInfo);
            const metadata = collectionInfo.metadata;
            if (metadata.collection?.["value"]) {
                callback({
                    text: `Unable to process mint request. Invalid collection address ${content.collectionAddress}.`,
                    content: { error: "Invalid collection address." },
                });
                return false;
            }
            if (metadata) {
                elizaLogger.log("nft params", {});
                const nftRes = await createNFT({
                    runtime,
                    collectionName: metadata.name,
                    collectionAddress: content.collectionAddress,
                    collectionAdminPublicKey: metadata.updateAuthority,
                    collectionFee: metadata.sellerFeeBasisPoints,
                    tokenId: 1,
                });

                elizaLogger.log("NFT Address:", nftRes);

                if (nftRes) {
                    callback({
                        text: `Congratulations to you! 🎉🎉🎉 \nCollection Address: ${content.collectionAddress}\n NFT Address: ${nftRes.address}\n NFT Link: ${nftRes.link}`, //caption.description,
                        attachments: [],
                    });
                    await sleep(15000);
                    await verifyNFT({
                        runtime,
                        collectionAddress: content.collectionAddress,
                        NFTAddress: nftRes.address,
                    });
                } else {
                    callback({
                        text: `Mint NFT Error in ${content.collectionAddress}.`,
                        content: { error: "Mint NFT Error." },
                    });
                    return false;
                }
            } else {
                callback({
                    text: "Unable to process mint request. Invalid collection address.",
                    content: { error: "Invalid collection address." },
                });
                return false;
            }
            return [];
        } catch (e: any) {
            console.log(e);
        }

        // callback();
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "mint nft for collection: D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've minted a new NFT in your specified collection.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Could you create an NFT in collection D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Successfully minted your NFT in the specified collection.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please mint a new token in D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS collection",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your NFT has been minted in the collection successfully.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Generate NFT for D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've generated and minted your NFT in the collection.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I want to mint an NFT in collection D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your NFT has been successfully minted in the collection.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Create a new NFT token in D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS collection",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The NFT has been created in your specified collection.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Issue an NFT for collection D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've issued your NFT in the requested collection.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Make a new NFT in D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your new NFT has been minted in the collection.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you mint an NFT for D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS collection?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've completed minting your NFT in the collection.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Add a new NFT to collection D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "A new NFT has been added to your collection.",
                    action: "MINT_NFT",
                },
            },
        ],
    ],
} as Action;

export default mintNFTAction;
