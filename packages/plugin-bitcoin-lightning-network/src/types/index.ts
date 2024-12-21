export interface WalletInfo {
    id: string;
    name: string;
    balance: number;
}

export interface PaymentResponse {
    payment_hash: string;
}

export interface Tag {
    tagName: string;
    data: string | number | boolean | unknown;
}

export interface DecodedInvoice {
    paymentRequest: string;
    prefix: string;
    wordsTemp: string;
    complete: boolean;
    millisatoshis: string;
    satoshis: number;
    timestamp: number;
    timestampString: string;
    timeExpireDate: number;
    timeExpireDateString: string;
    tags: Tag[];
    merchantName?: string;
    description?: string;
}

export interface HumanFriendlyInvoice {
    network: string;
    amount: number;
    description: string;
    expiryDate: string;
    status: string;
}

export interface ProviderError extends Error {
    data?: unknown;
}
