import { ok, badRequest, serverError, response } from 'wix-http-functions';
import { getSecret } from 'wix-secrets-backend';
import { confirmOrder, getOrder } from 'backend/getEvent.web';
import wixData from 'wix-data';
import { sendTicketEmail } from 'backend/email.web';
import { getVivaWebhookKey } from 'backend/viva.jsw';
import { verifySignature } from 'backend/myPos.jsw';

async function isPermitted(headers, query, body) {
    try {
        const sharedAuthKey = await getSecret('vivaWebhookSecret');
        console.log('Retrieved vivaWebhookSecret:', sharedAuthKey ? 'Set' : 'Not set');

        // Log all headers, query parameters, and body for debugging
        console.log('Request headers:', JSON.stringify(headers, null, 2));
        console.log('Query parameters:', JSON.stringify(query, null, 2));
        console.log('Request body:', JSON.stringify(body, null, 2));

        // Normalize header names to lowercase for case-insensitive matching
        const normalizedHeaders = Object.keys(headers).reduce((acc, key) => {
            acc[key.toLowerCase()] = headers[key];
            return acc;
        }, {});

        const authHeader = normalizedHeaders['authorization'] || normalizedHeaders['x-api-key'] || normalizedHeaders['x-viva-signature'];
        const authQuery = query && query.auth;

        // If no authentication headers or query parameters are present, log and proceed
        if (!authHeader && !authQuery) {
            console.warn('No authorization header or query parameter provided; proceeding without authentication');
            return true; // Temporarily bypass authentication
        }

        if (authHeader) {
            if (authHeader.toLowerCase().startsWith('bearer ')) {
                const token = authHeader.substring(7).trim();
                console.log('Bearer token:', token);
                return token === sharedAuthKey;
            }
            console.log('Direct auth header:', authHeader);
            return authHeader === sharedAuthKey;
        }

        if (authQuery) {
            console.log('Auth query parameter:', authQuery);
            return authQuery === sharedAuthKey;
        }

        return false;
    } catch (err) {
        console.error('Error validating authorization:', err);
        return false;
    }
}

export async function get_transactionPaymentCreated(request) {
    try {
        const webhookKey = await getVivaWebhookKey();

        if (!webhookKey) {
            console.error('Failed to retrieve webhook key');
            return badRequest({
                body: { error: 'Failed to generate webhook key' },
                headers: { 'Content-Type': 'application/json' }
            });
        }
        console.log('Webhook verification key generated:', webhookKey);
        return ok({
            body: { Key: webhookKey },
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Error in webhook verification:', error);
        return serverError({
            body: { error: 'Internal server error during verification' },
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export async function post_transactionPaymentCreated(request) {
    let webhookData;
    let downloadUrl;

    try {
        const headers = request.headers;
        const query = request.query;
        webhookData = await request.body.json();

        // Log raw request details for debugging
        console.log('Received webhook data:', JSON.stringify(webhookData, null, 2));

        // Temporarily bypass authentication for testing
        // if (!(await isPermitted(headers, query, webhookData))) {
        //     console.error('Unauthorized webhook request', { headers, query });
        //     return badRequest({
        //         body: { error: 'Unauthorized' },
        //         headers: { 'Content-Type': 'application/json' }
        //     });
        // }

        await wixData.insert('logs', {
            phase: 'webhook_data',
            data: { webhookData },
            ts: new Date().toISOString()
        });

        const safeGet = (obj, path, defaultValue = null) => {
            try {
                return path.reduce((current, key) => current?.[key], obj) ?? defaultValue;
            } catch {
                return defaultValue;
            }
        };

        const eventTypeId = safeGet(webhookData, ['EventTypeId']);
        const orderCode = safeGet(webhookData, ['EventData', 'OrderCode']);
        const transactionId = safeGet(webhookData, ['EventData', 'TransactionId']);
        const statusId = safeGet(webhookData, ['EventData', 'StatusId']);
        const amount = safeGet(webhookData, ['EventData', 'Amount']);
        const fullName = safeGet(webhookData, ['EventData', 'fullName']);
        const merchantId = safeGet(webhookData, ['EventData', 'MerchantId']);
        const customerEmail = safeGet(webhookData, ['EventData', 'Email']);
        const customerTrns = safeGet(webhookData, ['EventData', 'CustomerTrns']);
        const merchantTrns = safeGet(webhookData, ['EventData', 'MerchantTrns']);
        const currencyCode = safeGet(webhookData, ['EventData', 'CurrencyCode']);
        const insDate = safeGet(webhookData, ['EventData', 'InsDate']);
        const cardNumber = safeGet(webhookData, ['EventData', 'CardNumber']);

        if (eventTypeId !== 1796) {
            console.error('Invalid webhook event type', { eventTypeId });
            return badRequest({
                body: { code: 'INVALID_EVENT_TYPE', message: 'Webhook event type is not Transaction Payment Created (1796)' },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (!orderCode || !transactionId || !statusId || amount == null || !merchantTrns) {
            console.error('Missing required webhook fields', { orderCode, transactionId, statusId, amount, merchantTrns });
            return badRequest({
                body: { code: 'MISSING_FIELDS', message: 'Required fields (OrderCode, TransactionId, StatusId, Amount, MerchantTrns) are missing' },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (statusId !== 'F') {
            console.error('Transaction not successful', { statusId });
            return badRequest({
                body: { code: 'TRANSACTION_NOT_SUCCESSFUL', message: `Transaction status is ${statusId}, expected 'F' for success` },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (typeof amount !== 'number' || amount <= 0) {
            console.error('Invalid amount', { amount });
            return badRequest({
                body: { code: 'INVALID_AMOUNT', message: 'Amount must be a positive number' },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Split merchantTrns into orderId and eventId
        const [orderId, eventId] = merchantTrns.split(':');
        if (!orderId || !eventId) {
            console.error('Invalid merchantTrns format', { merchantTrns });
            await wixData.insert('logs', {
                phase: 'webhook_processing_error',
                data: { errorMessage: 'Invalid merchantTrns format, expected orderId:eventId', merchantTrns },
                ts: new Date().toISOString()
            });
            return ok({
                body: { code: 'INVALID_MERCHANT_TRNS', message: 'Invalid merchantTrns format' },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Validate eventId is a UUID
        const isValidUUID = (id) => {
            const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            return regex.test(id);
        };
        if (!isValidUUID(eventId)) {
            console.error('Invalid eventId format', { eventId });
            await wixData.insert('logs', {
                phase: 'webhook_processing_error',
                data: { errorMessage: 'eventId is not a valid UUID', eventId },
                ts: new Date().toISOString()
            });
            return ok({
                body: { code: 'INVALID_EVENT_ID', message: 'eventId is not a valid UUID' },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        console.log('Processing successful transaction', {
            orderCode,
            transactionId,
            amount,
            currencyCode,
            customerEmail,
            merchantId,
            customerTrns,
            merchantTrns,
            orderId,
            eventId,
            insDate,
            cardNumber: cardNumber ? `****${cardNumber.slice(-4)}` : 'N/A'
        });

        // Update Wix order (confirmOrder)
        try {
            const options = { orderNumber: [orderId] }; // Corrected to orderNumber, kept as array per documentation
            console.log('Confirming order with options:', { eventId, options });
            const confirmResult = await confirmOrder(eventId, options);
            console.log('Order confirmed successfully', {
                orderId,
                eventId,
                confirmResult
            });

            await wixData.insert('logs', {
                phase: 'webhook_order_confirm',
                data: {
                    orderId,
                    eventId,
                    transactionId,
                    orderCode,
                    amount,
                    confirmResult
                },
                ts: new Date().toISOString()
            });
        } catch (confirmError) {
            console.error('Error confirming order in Wix:', {
                orderId,
                eventId,
                error: confirmError.message,
                stack: confirmError.stack,
                details: confirmError.details || {}
            });
            await wixData.insert('logs', {
                phase: 'webhook_order_confirm_error',
                data: {
                    orderId,
                    eventId,
                    transactionId,
                    orderCode,
                    errorMessage: confirmError.message,
                    stack: confirmError.stack,
                    details: confirmError.details || {}
                },
                ts: new Date().toISOString()
            });
            // Continue processing
        }

        // Get order details
        let getOrderResponse = null;
        const identifiers = {
            eventId: eventId,
            orderNumber: orderId // Corrected to orderNumber, changed to string per documentation
        };
        const options1 = {
            fieldset: ["TICKETS", "DETAILS"]
        };
        try {
            console.log('Fetching order with identifiers:', identifiers);
            getOrderResponse = await getOrder(identifiers, options1);
            const tickets = getOrderResponse;
            if (tickets.length === 0) {
                throw new Error("No tickets found in order.");
            }

            const firstTicket = tickets[0];
            downloadUrl = firstTicket.pdfUrl;
            if (!downloadUrl) {
                throw new Error("No valid ticket URL found (checkInUrl).");
            }
            await wixData.insert('logs', {
                phase: 'get_order_complete',
                data: { getOrderResponse },
                ts: new Date().toISOString()
            });
        } catch (getOrderError) {
            console.error('Get order failed:', {
                orderId,
                eventId,
                error: getOrderError.message,
                stack: getOrderError.stack,
                details: getOrderError.details || {}
            });
            await wixData.insert('logs', {
                phase: 'get_order_error',
                data: {
                    orderId,
                    eventId,
                    errorMessage: getOrderError.message,
                    stack: getOrderError.stack,
                    details: getOrderError.details || {}
                },
                ts: new Date().toISOString()
            });
            // Continue processing
        }

        // // Send email if downloadUrl and customerEmail are available
        // if (downloadUrl && customerEmail) {
        //     try {
        //         await sendTicketEmail(fullName || 'Customer New', customerEmail, downloadUrl);
        //         console.log('Ticket email sent successfully', { customerEmail, orderId });
        //         await wixData.insert('logs', {
        //             phase: 'email_sent_success',
        //             data: { customerEmail, orderId, downloadUrl },
        //             ts: new Date().toISOString()
        //         });
        //     } catch (emailError) {
        //         console.error('Error sending ticket email:', {
        //             customerEmail,
        //             orderId,
        //             error: emailError.message,
        //             stack: emailError.stack
        //         });
        //         await wixData.insert('logs', {
        //             phase: 'email_send_error',
        //             data: {
        //                 customerEmail,
        //                 orderId,
        //                 errorMessage: emailError.message
        //             },
        //             ts: new Date().toISOString()
        //         });
        //     }
        // } else {
        //     console.warn('Skipping email send: missing downloadUrl or customerEmail', { downloadUrl: !!downloadUrl, customerEmail });
        //     await wixData.insert('logs', {
        //         phase: 'email_skipped',
        //         data: { reason: 'missing downloadUrl or customerEmail', orderId },
        //         ts: new Date().toISOString()
        //     });
        // }

        return ok({
            body: {
                code: 'SUCCESS',
                message: 'Transaction processed successfully',
                data: { orderCode, transactionId, amount, currencyCode, merchantId, orderId, eventId }
            },
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Error processing webhook', { error: error.message, stack: error.stack });
        await wixData.insert('logs', {
            phase: 'webhook_processing_error',
            data: {
                errorMessage: error.message,
                webhookData
            },
            ts: new Date().toISOString()
        });
        return ok({
            body: { code: 'ACKNOWLEDGED', message: 'Webhook received but processing failed internally' },
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * myPOS Purchase Notify Webhook
 * Triggered server-to-server by myPOS to confirm payment status.
 */
export async function post_myposNotify(request) {
    const ts = new Date().toISOString();
    console.log(`[myPOS Notify ${ts}] Webhook hit - START`);
    try {
        const headers = request.headers;
        const bodyText = await request.body.text();
        console.log(`[myPOS Notify ${ts}] Raw Body:`, bodyText);
        console.log(`[myPOS Notify ${ts}] Headers:`, JSON.stringify(headers));

        const params = new URLSearchParams(bodyText);
        const postData = {};
        for (const [key, value] of params.entries()) {
            postData[key] = value;
        }

        console.log(`[myPOS Notify ${ts}] Parsed Data:`, JSON.stringify(postData, null, 2));

        await wixData.insert('logs', {
            phase: 'mypos_notify_received',
            data: { postData, headers, bodyText },
            ts
        });

        // 1. Validate Signature
        const signature = postData.Signature;
        if (!signature) {
            console.error(`[myPOS Notify ${ts}] Missing signature`);
            return response({
                status: 200,
                body: 'OK',
                headers: { 'Content-Type': 'text/plain' }
            });
        }

        console.log(`[myPOS Notify ${ts}] Validating signature...`);
        const isValid = await verifySignature(postData, signature, bodyText);
        console.log(`[myPOS Notify ${ts}] Signature Valid: ${isValid}`);

        if (!isValid) {
            console.error(`[myPOS Notify ${ts}] Invalid signature detected`);
            return response({
                status: 200,
                body: 'OK',
                headers: { 'Content-Type': 'text/plain' }
            });
        }

        // 2. Extract Key Fields
        const orderId = postData.OrderID;
        const amount = postData.Amount;
        const currency = postData.Currency;
        const status = postData.IPCmethod;

        console.log(`[myPOS Notify ${ts}] OrderID: ${orderId}, Amount: ${amount}, Currency: ${currency}, Method: ${status}`);

        // 3. Handle Notification Type
        if (status === 'IPCPurchaseRollback') {
            console.warn(`[myPOS Notify ${ts}] TRANSACTION ROLLBACK RECEIVED for order: ${orderId}`);
            await wixData.insert('logs', {
                phase: 'mypos_notify_rollback',
                data: { orderId, postData },
                ts
            });

            // Return OK to myPOS to acknowledge the rollback notification
            return response({
                status: 200,
                body: 'OK',
                headers: { 'Content-Type': 'text/plain' }
            });
        }

        if (status !== 'IPCPurchaseNotify') {
            console.warn(`[myPOS Notify ${ts}] Unhandled IPCmethod: ${status}`);
            return response({
                status: 200,
                body: 'OK',
                headers: { 'Content-Type': 'text/plain' }
            });
        }

        // 4. Merchant Logic: Verify Order and Update Status
        let eventId = postData.Note;
        const isValidUUID = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

        if (eventId && isValidUUID(eventId)) {
            console.log(`[myPOS Notify ${ts}] EventId extracted from Note: ${eventId}`);
        } else {
            console.warn(`[myPOS Notify ${ts}] No valid eventId in Note field, falling back to lookup for order: ${orderId}`);
            try {
                console.log(`[myPOS Notify ${ts}] Looking up order: ${orderId}`);

                // Try query by orderNumber FIRST (most likely case for 3003-7SP2-SP8 format)
                const orderResults = await wixData.query("Events/Orders")
                    .contains("orderNumber", orderId)
                    .limit(1)
                    .find();

                if (orderResults.items.length > 0) {
                    const orderRecord = orderResults.items[0];
                    console.log(`[myPOS Notify ${ts}] Order found via query:`, JSON.stringify(orderRecord));
                    eventId = orderRecord.eventId;
                } else {
                    // Try direct GET by ID as fallback
                    try {
                        const orderRecord = await wixData.get("Events/Orders", orderId);
                        if (orderRecord) {
                            console.log(`[myPOS Notify ${ts}] Order found via direct GET:`, JSON.stringify(orderRecord));
                            eventId = orderRecord.eventId;
                        }
                    } catch (getError) {
                        console.log(`[myPOS Notify ${ts}] Direct GET failed, maybe not a UUID.`);
                    }
                }
            } catch (e) {
                console.error(`[myPOS Notify ${ts}] Error resolving orderId to eventId:`, e.message);
            }
        }

        if (eventId) {
            // 5. Confirm the Order in Wix
            console.log(`[myPOS Notify ${ts}] Confirming order in Wix for event: ${eventId}, order: ${orderId}`);
            const confirmOptions = { orderNumber: [orderId] };
            const confirmResult = await confirmOrder(eventId, confirmOptions);

            console.log(`[myPOS Notify ${ts}] Order confirmation successful:`, JSON.stringify(confirmResult));

            await wixData.insert('logs', {
                phase: 'mypos_notify_success',
                data: { orderId, eventId, confirmResult },
                ts
            });
        } else {
            console.error(`[myPOS Notify ${ts}] Final resolve failed: Could not determine eventId for OrderID: ${orderId}`);
        }

        // 6. Respond with OK (Strictly plain text as per myPOS requirements)
        return response({
            status: 200,
            body: 'OK',
            headers: { 'Content-Type': 'text/plain' }
        });

    } catch (error) {
        console.error(`[myPOS Notify ${ts}] Critical Processing Error:`, error.message, error.stack);
        await wixData.insert('logs', {
            phase: 'mypos_notify_error',
            data: { errorMessage: error.message, stack: error.stack },
            ts
        });
        return response({
            status: 200,
            body: 'OK',
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}

/**
 * myPOS Purchase OK Redirect
 * Triggered when the customer is redirected back after successful payment.
 */
export async function post_myposOk(request) {
    const ts = new Date().toISOString();
    console.log(`[myPOS OK Redirect ${ts}] Redirect hit - START`);
    try {
        const bodyText = await request.body.text();
        console.log(`[myPOS OK Redirect ${ts}] Raw Body:`, bodyText);

        const params = new URLSearchParams(bodyText);
        const postData = {};
        for (const [key, value] of params.entries()) {
            postData[key] = value;
        }

        console.log(`[myPOS OK Redirect ${ts}] Parsed Data:`, JSON.stringify(postData, null, 2));

        await wixData.insert('logs', {
            phase: 'mypos_ok_received',
            data: { postData, bodyText },
            ts
        });

        // 1. Validate Signature
        const signature = postData.Signature;
        if (signature) {
            console.log(`[myPOS OK Redirect ${ts}] Validating signature...`);
            const isValid = await verifySignature(postData, signature, bodyText);
            console.log(`[myPOS OK Redirect ${ts}] Signature Valid: ${isValid}`);
            if (!isValid) {
                console.error(`[myPOS OK Redirect ${ts}] Invalid signature on OK redirect`);
                // Continue redirect even if signature fails, but log error
            }
        } else {
            console.warn(`[myPOS OK Redirect ${ts}] No signature found on OK redirect`);
        }

        const orderId = postData.OrderID;
        let eventId = postData.Note;
        console.log(`[myPOS OK Redirect ${ts}] OrderID: ${orderId}, Note: ${eventId}`);

        const isValidUUID = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

        if (eventId && isValidUUID(eventId)) {
            console.log(`[myPOS OK Redirect ${ts}] EventId extracted from Note: ${eventId}`);
        } else {
            console.log(`[myPOS OK Redirect ${ts}] No valid eventId in Note, trying lookup...`);
            eventId = '';
            try {
                console.log(`[myPOS OK Redirect ${ts}] Fetching order record for eventId resolve...`);
                const orderRecord = await wixData.get("Events/Orders", orderId);
                if (orderRecord && orderRecord.eventId) {
                    eventId = orderRecord.eventId;
                    console.log(`[myPOS OK Redirect ${ts}] Resolved via Orders: ${eventId}`);
                }
            } catch (e) {
                console.warn(`[myPOS OK Redirect ${ts}] Orders lookup failed: ${e.message}`);
            }

            if (!eventId) {
                console.log(`[myPOS OK Redirect ${ts}] Trying fallback Tickets lookup...`);
                const ticketResults = await wixData.query("Events/Tickets")
                    .eq("orderNumber", orderId)
                    .find();
                if (ticketResults.items.length > 0) {
                    eventId = ticketResults.items[0].event;
                    console.log(`[myPOS OK Redirect ${ts}] Resolved via Tickets: ${eventId}`);
                }
            }
        }

        const thankYouUrl = `https://www.live-ls.com/thank-you?tid=${orderId}&oid=${orderId}&eid=${eventId}`;
        console.log(`[myPOS OK Redirect ${ts}] Final Redirecting to: ${thankYouUrl}`);

        return response({
            status: 200,
            headers: { "Location": thankYouUrl }
        });

    } catch (error) {
        console.error(`[myPOS OK Redirect ${ts}] Critical Error:`, error.message);
        return response({
            status: 200,
            headers: { "Location": "https://www.live-ls.com/thank-you?status=error" }
        });
    }
}

/**
 * myPOS Purchase Cancel Redirect
 * Triggered when the customer cancels the payment on the myPOS page.
 */
export async function post_myposCancel(request) {
    const ts = new Date().toISOString();
    console.log(`[myPOS Cancel ${ts}] Cancel hit - START`);
    try {
        const bodyText = await request.body.text();
        console.log(`[myPOS Cancel ${ts}] Raw Body:`, bodyText);

        const params = new URLSearchParams(bodyText);
        const postData = {};
        for (const [key, value] of params.entries()) {
            postData[key] = value;
        }

        console.log(`[myPOS Cancel ${ts}] Parsed Data:`, JSON.stringify(postData, null, 2));

        await wixData.insert('logs', {
            phase: 'mypos_cancel_received',
            data: { postData, bodyText },
            ts
        });

        // 1. Validate Signature (Optional for Cancel, but good practice)
        const signature = postData.Signature;
        if (signature) {
            const isValid = await verifySignature(postData, signature, bodyText);
            console.log(`[myPOS Cancel ${ts}] Signature Valid: ${isValid}`);
        }

        const orderId = postData.OrderID;
        const redirectUrl = `https://www.live-ls.com/thank-you?tid=${orderId}&status=cancelled`;

        console.log(`[myPOS Cancel ${ts}] Redirecting user to: ${redirectUrl}`);

        return response({
            status: 200,
            headers: { "Location": redirectUrl }
        });

    } catch (error) {
        console.error(`[myPOS Cancel ${ts}] Error:`, error.message);
        return response({
            status: 200,
            headers: { "Location": "https://www.live-ls.com/" }
        });
    }
}

/**
 * Handle GET requests for Redirects (Optional but recommended)
 */
export async function get_myposOk(request) {
    console.log(`[myPOS OK GET] Request received at ${new Date().toISOString()}`);
    return post_myposOk(request);
}

export async function get_myposCancel(request) {
    console.log(`[myPOS Cancel GET] Request received at ${new Date().toISOString()}`);
    return post_myposCancel(request);
}

