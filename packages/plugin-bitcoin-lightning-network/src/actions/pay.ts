import {
    composeContext,
    elizaLogger,
    generateObjectDeprecated,
    HandlerCallback,
    ModelClass,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@ai16z/eliza";

import { initWalletProvider, LNBitsProvider } from "../providers/lnbits";
import { payInvoiceTemplate } from "../templates";

// Exported for tests
export class PayInvoiceAction {
    constructor(private lnbitsProvider: LNBitsProvider) {}

    async payInvoice(invoice: string): Promise<{ status: string }> {
        console.log(`Received bolt11 invoice: ${invoice}`);
        const decodedInvoice =
            this.lnbitsProvider.toHumanFriendlyInvoice(invoice);
        console.log(`Decoded invoice: ${JSON.stringify(decodedInvoice)}`);

        try {
            await this.lnbitsProvider.payInvoice(invoice);
            console.log("Invoice paid successfully");
            return {
                status: "success",
            };
        } catch (error) {
            throw new Error(`Pay invoice failed: ${error.message}`);
        }
    }
}

export const payInvoiceAction = {
    name: "payInvoice",
    description: "Pay an invoice",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback?: HandlerCallback
    ) => {
        console.log("Pay invoice action handler called");
        const provider = initWalletProvider(runtime);
        const action = new PayInvoiceAction(provider);

        // Compose pay invoice context
        const payInvoiceContext = composeContext({
            state,
            template: payInvoiceTemplate,
        });

        // Generate pay invoice content
        const content = await generateObjectDeprecated({
            runtime,
            context: payInvoiceContext,
            modelClass: ModelClass.LARGE,
        });

        const invoice = content.invoice;

        const humanFriendlyInvoice = provider.toHumanFriendlyInvoice(invoice);
        elizaLogger.info("Invoice: ", JSON.stringify(humanFriendlyInvoice));

        try {
            const status = await action.payInvoice(invoice);
            return true;
        } catch (error) {
            console.error("Error during invoice payment:", error);
            return false;
        }
    },
    template: payInvoiceTemplate,
    validate: async (runtime: IAgentRuntime) => {
        /*const nodeUrl = runtime.getSetting("BITCOIN_LNBITS_NODE_URL");
        const adminKey = runtime.getSetting("BITCOIN_LNBITS_ADMIN_KEY");
        const readKey = runtime.getSetting("BITCOIN_LNBITS_READ_KEY");
        return (
            typeof nodeUrl === "string" &&
            typeof adminKey === "string" &&
            typeof readKey === "string"
        );*/
        // TODO: Add validation
        return true;
    },
    examples: [
        [
            {
                user: "assistant",
                content: {
                    text: "I'll help you pay a Lightning Network invoice",
                    action: "PAY_INVOICE",
                },
            },
            {
                user: "user",
                content: {
                    text: "Pay this invoice lnbc420n1pnk2ldtpp5metd9zs6zq289792njdy2se6gn4wpnymsxnu072jkvh6amn4nycqdqqcqzzsxqyz5vqsp5092dcyqynwejfum3njrnyuj90c2h8h5gavqyjq6jvc8t2calcyhs9qxpqysgq8uama2svx2ms97n9ufwqpt5w9pfulnyc5kxfz22de2mqwaxyjrn96dthvfahcy4z088zdx8fldq22f7um5vjyms6s7gkc53q5jhds3gpsl4lwe",
                    action: "PAY_INVOICE",
                },
            },
        ],
    ],
    similes: ["PAY_INVOICE"],
};
