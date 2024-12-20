import { createClient } from "xmtp";

export async function startXmtpClient() {
    const onMessage = async (message, user) => {
        console.log(`Decoded message: ${message} by ${user}`);
        const response = "Your AI response here"; // Replace with actual AI response logic
        await xmtp.send(response);
    };

    const xmtp = await createClient(onMessage, {
        encryptionKey: process.env.EVM_PRIVATE_KEY,
    });

    console.log("XMTP client started");
}
