import type { IAgentRuntime, Provider, Memory, State } from "@ai16z/eliza";
import { HumanFriendlyInvoice, WalletInfo } from "../types";
import { LNBitsClient } from "../lnbits_clients";

export class LNBitsProvider {
    private lnbitsClient: LNBitsClient;

    constructor(nodeUrl: string, adminKey: string, readKey: string) {
        this.lnbitsClient = new LNBitsClient(nodeUrl, adminKey, readKey);
    }

    async getWalletInfo(): Promise<WalletInfo> {
        return this.lnbitsClient.getWalletInfo();
    }

    async payInvoice(invoice: string): Promise<boolean> {
        try {
            await this.lnbitsClient.sendPayment(invoice);
            return true;
        } catch (error) {
            throw new Error(`Failed to pay invoice: ${error.message}`);
        }
    }

    toHumanFriendlyInvoice(invoice: string): HumanFriendlyInvoice {
        return this.lnbitsClient.toHumanFriendlyInvoice(invoice);
    }
}

export const initWalletProvider = (runtime: IAgentRuntime) => {
    const nodeUrl = runtime.getSetting("BITCOIN_LNBITS_NODE_URL");
    const adminKey = runtime.getSetting("BITCOIN_LNBITS_ADMIN_KEY");
    const readKey = runtime.getSetting("BITCOIN_LNBITS_READ_KEY");
    const provider = new LNBitsProvider(nodeUrl, adminKey, readKey);

    return provider;
};

const lnbitsProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<string | null> => {
        try {
            const provider = initWalletProvider(runtime);

            const walletInfo = await provider.getWalletInfo();
            return `${walletInfo.name} has ${walletInfo.balance} sats`;
        } catch (error) {
            console.error("Error in wallet provider:", error);
            return null;
        }
    },
};

// Module exports
export { lnbitsProvider };
