# myPOS Checkout Integration for Wix (v3.0)

This repository contains a robust, secure, and production-ready integration for the myPOS Checkout API tailored specifically for Wix websites. It handles the full payment lifecycle, including signature generation, webhook notification, and customer redirects.

## 🚀 Features

- **Standard Redirect Method (IPCPurchase)**: Generates secure, signed checkout URLs.
- **Server-to-Server Notifications**: Robust handling of `IPCPurchaseNotify` to confirm payments.
- **Dedicated Redirect Handlers**: Custom endpoints for "Success" (OK) and "Cancel" responses.
- **RSA-SHA256 Security**: Full implementation of myPOS signature and verification logic.
- **Extensive Logging**: Detailed telemetry logged to both the Wix Console and the `logs` collection.
- **Auto-Provisioning**: Correctly handles Wix Order confirmation and Event ID resolution.

## 📁 File Structure

- **`myPos.jsw`**: Backend logic for signature generation, signature verification, and API communication.
- **`http-functions.js`**: Webhook endpoints exposed at `/_functions/myposNotify`, `myposOk`, and `myposCancel`.
- **`myPos.js`**: Frontend interface logic to initiate the transaction from the checkout page.

## 🛠️ Prerequisites

1.  **myPOS Merchant Account**: Required `SID`, `WalletNumber`, and `KeyIndex`.
2.  **Wix Secrets Manager**: You MUST store your keys in the Secrets Manager with these exact names:
    -   `myPos_privateKey`: Your Store Private Key (PEM format).
    -   `myPos_publicKey`: The myPOS Public Certificate (PEM format).

## 📡 Webhook Endpoints

Configure these in your myPOS Merchant Cabinet:

| Type | Endpoint URL | Requirement |
| :--- | :--- | :--- |
| **Notification** | `https://yourdomain.com/_functions/myposNotify` | Must return `OK` |
| **Success Redirect** | `https://yourdomain.com/_functions/myposOk` | Browser Redirect |
| **Cancel Redirect** | `https://yourdomain.com/_functions/myposCancel` | Browser Redirect |

## 💻 Usage

### Initiate a Payment
From your checkout page or event page:

```javascript
import { createTransaction } from 'backend/myPos';

// 'options' provided by Wix Checkout or custom form
const result = await createTransaction(options);
if (result.redirectUrl) {
    wixLocation.to(result.redirectUrl);
}
```

### Webhook Handling (Internal)
The `http-functions.js` file automatically handles incoming POST/GET requests. It:
1.  **Parses** URL-encoded data.
2.  **Verifies** the `Signature` using your Public Key.
3.  **Matches** the `OrderID` to a Wix Event/Ticket.
4.  **Confirms** the order status in the Wix database.
5.  **Redirects** the user to the configured `"Thank You"` page.

## 🛡️ Security
-   All private keys are stored in the **Wix Secrets Manager** and never exposed to the frontend.
-   Signatures are generated using **RSA-SHA256**.
-   Webhooks are verified against the myPOS certificate to prevent spoofing.

## 📝 Logging & Monitoring
This integration implements a tiered logging system:
-   **Site Monitoring**: Real-time console logs with `[myPOS ...]` prefixes.
-   **Database Logs**: Entries in the `logs` collection for every phase (start, signature, API response, webhook hit).

---
*Developed for robust payment processing on Wix platforms.*
