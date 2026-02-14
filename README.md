# myPOS Checkout Integration for Wix

This repository contains a robust integration for the myPOS Checkout API tailored for Wix websites. It handles signature generation, session management, and webhook verification using RSA-SHA256.

## Features

- **Session-Based Checkout**: Securely create payment sessions and redirect users.
- **Static Checkout URL**: Generate signed direct-payment URLs (IPCPurchase).
- **Webhook Verification**: Securely handle `IPCPurchaseNotify` callbacks from myPOS.
- **Production Ready**: Configured for the myPOS production environment.

## File Structure

- `myPos.jsw`: The main backend file containing all myPOS logic.
- `http-functions.js`: Required for handling the `_functions/handleMyPosNotify` webhook.

## Prerequisites

1. **myPOS Account**: A registered myPOS merchant account.
2. **Wix Secrets Manager**: Store your keys as:
   - `myPos_privateKey`: Your Merchant Private Key.
   - `myPos_publicKey`: The myPOS Public Key.

## Usage

### 1. Create a Payment Session
This is the recommended method for Wix.

```javascript
import { createMyPosPaymentSession } from 'backend/myPos';

const params = {
    amount: 10.50,
    orderid: "ORD-12345",
    currency: "EUR"
};

const result = await createMyPosPaymentSession(params);
if (result.success) {
    wixLocation.to(result.redirectUrl);
}
```

### 2. Set Up Webhooks
In your `http-functions.js`, implement the notify handler:

```javascript
import { handleMyPosNotify } from 'backend/myPos';

export async function post_handleMyPosNotify(request) {
    const body = await request.bodyJson();
    return handleMyPosNotify(body);
}
```

## Security Note

Always ensure `OrderID` is unique for every transaction to avoid redirect errors. All sensitive communication is backend-based to protect your private keys.
