import { getMyPosCheckoutUrl } from 'backend/myPos';
import wixData from 'wix-data';

/** Helpers */
const toTwoDecimals = (n) => Number(n).toFixed(2);
const centsToDecimal = (v) => {
    if (v == null || v === '') return null;
    const str = String(v).trim();
    if (/^\d+$/.test(str)) return toTwoDecimals(Number(str) / 100); // cents
    if (/^\d+(\.\d{1,2})$/.test(str)) return toTwoDecimals(Number(str)); // already decimal
    return null;
};

const safeStr = (v) => (v == null ? '' : String(v));
const buildDescription = (order) => {
    const descFromOrder = order?.description?.text || order?.description?.title || '';
    if (descFromOrder) return safeStr(descFromOrder).slice(0, 150);
    const items = order?.description?.items || [];
    const names = items.map(i => safeStr(i?.name)).filter(Boolean);
    return names.join(', ').trim() || 'Order Payment';
};

export const connectAccount = async (options, context) => {
    const { credentials } = options;
    return { credentials };
};

export const createTransaction = async (options, context) => {
    const { merchantCredentials, order, wixTransactionId } = options || {};

    const cleanDescription = (desc) => {
        if (!desc) return 'Order Payment';
        return desc
            .replace(/<[^>]+>/g, '')
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .substring(0, 20)
            .trim();
    };

    const isValidUUID = (id) => {
        const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        return regex.test(id);
    };

    const rawTotal = order?.totalAmount ?? order?.description?.totalAmount;
    const amount = centsToDecimal(rawTotal);
    const shortId = order._id;
    const description = cleanDescription(buildDescription(order));

    // Extract customer info from the order
    const billingAddress = order?.description?.billingAddress || {};
    const email = billingAddress.email || 'customer@example.com';
    const firstName = billingAddress.firstName || billingAddress.first_name || 'Customer';
    const lastName = billingAddress.lastName || billingAddress.last_name || 'Name';
    const phone = billingAddress.phone || '';
    const country = billingAddress.country || '';
    const city = billingAddress.city || '';
    const zipCode = billingAddress.zipCode || billingAddress.postalCode || '';
    const address = billingAddress.address || billingAddress.addressLine1 || '';

    const itemsRaw = Array.isArray(order?.description?.items) ? order.description.items : [];
    const items = itemsRaw.filter(item => item._id && isValidUUID(item._id));

    if (items.length === 0) {
        return { code: 'NO_VALID_ITEMS', message: 'No valid ticket items found' };
    }

    const itemIds = items.map(item => item._id);
    const results = await wixData.query("Events/Tickets").hasSome("_id", itemIds).find();
    const ticketsMap = new Map(results.items.map(ticket => [ticket._id, ticket]));

    const tickets = [];
    for (let item of items) {
        try {
            const ticket = ticketsMap.get(item._id);
            if (ticket) {
                tickets.push(ticket);
            } else {
                throw new Error(`No ticket found for itemId: ${item._id}`);
            }
        } catch (e) {
            console.error(`Error processing ticket for itemId: ${item._id}`, e);
        }
    }

    if (tickets.length === 0) {
        return { code: 'NO_VALID_TICKETS', message: 'No valid tickets found' };
    }

    const eventIds = new Set(tickets.map(ticket => ticket.event));
    if (eventIds.size > 1) {
        return { code: 'MULTIPLE_EVENTS', message: 'All tickets must belong to the same event' };
    }
    const eventId = eventIds.values().next().value;

    // Build payment data for myPOS — mirrors the Viva approach
    const paymentData = {
        amount: Number(amount),           // myPOS expects decimal amount (e.g. 23.45)
        currency: 'EUR',
        orderid: `${shortId}:${eventId}`, // Combine orderId and eventId
        customeremail: email,
        customerfirstnames: firstName,
        customerfamilyname: lastName,
        customerphone: phone,
        customercountry: country,
        customercity: city,
        customerzipcode: zipCode,
        customeraddress: address,
        note: description,
    };

    console.log('myPOS createTransaction: paymentData', JSON.stringify(paymentData));

    // Call backend to get the myPOS hosted checkout URL
    const paymentUrl = await getMyPosCheckoutUrl(paymentData);

    console.log('myPOS createTransaction: redirectUrl', paymentUrl);

    return {
        redirectUrl: paymentUrl,
    };
};

export const refundTransaction = async (options, context) => { };