# `@ai16z/plugin-bitcoin-lightning-network`

This plugin provides actions and providers for interacting with Bitcoin Lightning Network.

---

## Configuration

### Default Setup

```env
BITCOIN_LNBITS_NODE_URL="https://demo.lnbits.com"
BITCOIN_LNBITS_ADMIN_KEY="..."
BITCOIN_LNBITS_READ_KEY="..."
```

## Providers

The **LNBits Provider** initializes with the configuration from the `.env` file.

- Provides the **context** of the currently connected account and its balance.
- Allows to **create invoices** and **pay invoices**.

---

## Actions

### Pay Invoice

Pay an invoice. Just specify the:

- **Invoice**

**Example usage:**

```bash
Pay invoice lnbc1...
```

---

## Contribution

The plugin contains tests. Whether you're using **TDD** or not, please make sure to run the tests before submitting a PR.

### Running Tests

Navigate to the `plugin-bitcoin-lightning-network` directory and run:

```bash
pnpm test
```
