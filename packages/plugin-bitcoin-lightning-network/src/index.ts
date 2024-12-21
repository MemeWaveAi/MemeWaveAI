import type { Plugin } from "@ai16z/eliza";
import { payInvoiceAction } from "./actions/pay";
import { lnbitsProvider } from "./providers/lnbits";

export const bitcoinLightningNetworkPlugin: Plugin = {
    name: "bitcoin",
    description: "Bitcoin integration plugin",
    providers: [lnbitsProvider],
    evaluators: [],
    services: [],
    actions: [payInvoiceAction],
};

export default bitcoinLightningNetworkPlugin;
