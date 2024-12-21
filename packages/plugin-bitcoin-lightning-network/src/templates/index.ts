export const payInvoiceTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested invoice:
- Invoice: Must be a valid Lightning invoice

Respond with a JSON markdown block containing only the extracted values. All fields are required:

\`\`\`json
{
    "invoice": string,
}
\`\`\`
`;
