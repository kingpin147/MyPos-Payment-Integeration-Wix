import { getMyPosCheckoutUrl } from 'backend/myPos';
import wixData from 'wix-data';



export const connectAccount = async (options, context) => {
    const { credentials } = options;
    return { credentials };
};

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

const ensureHttps = (url) => {
    if (!url) return '';
    if (url.startsWith('https://')) return url;
    if (url.startsWith('http://')) return url.replace('http://', 'https://');
    return `https://${url}`;
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

    // Extract customer info from the order with improved fallbacks
    const billingAddress = order?.description?.billingAddress || {};

    // Log the raw order to see exactly what Wix provides
    await wixData.insert('logs', {
        phase: 'createTransaction_raw_order',
        data: {
            orderKeys: Object.keys(order || {}),
            descriptionKeys: Object.keys(order?.description || {}),
            billingAddress,
            buyerInfo: order?.description?.buyerInfo || order?.buyerInfo || null,
            rawOrder: JSON.stringify(order).substring(0, 3000)
        },
        ts: new Date().toISOString()
    });

    const email = billingAddress.email
        || order?.description?.buyerInfo?.email
        || order?.buyerInfo?.email
        || order?.customerEmail
        || 'customer@example.com';

    const firstName = billingAddress.firstName
        || billingAddress.first_name
        || order?.description?.buyerInfo?.firstName
        || order?.buyerInfo?.firstName
        || 'Customer';

    const lastName = billingAddress.lastName
        || billingAddress.last_name
        || order?.description?.buyerInfo?.lastName
        || order?.buyerInfo?.lastName
        || 'Name';

    const phone = billingAddress.phone
        || billingAddress.phone_number
        || billingAddress.phoneNumber
        || order?.description?.buyerInfo?.phone
        || order?.buyerInfo?.phone
        || order?.customerPhone
        || '0000000000';

    const country = billingAddress.country
        || billingAddress.country_code
        || billingAddress.countryCode
        || order?.description?.buyerInfo?.country
        || order?.buyerInfo?.country
        || order?.customerCountry
        || 'PT';

    const city = billingAddress.city
        || billingAddress.town
        || order?.description?.buyerInfo?.city
        || order?.buyerInfo?.city
        || 'N/A';

    const zipCode = billingAddress.zipCode
        || billingAddress.postalCode
        || billingAddress.zip_code
        || billingAddress.zip
        || order?.description?.buyerInfo?.zipCode
        || order?.buyerInfo?.zipCode
        || '0000';

    const address = billingAddress.address
        || billingAddress.addressLine1
        || billingAddress.address_line1
        || billingAddress.street
        || order?.description?.buyerInfo?.address
        || order?.buyerInfo?.address
        || 'N/A';

    const itemsRaw = Array.isArray(order?.description?.items) ? order.description.items : [];
    const items = itemsRaw.filter(item => item._id && isValidUUID(item._id));

    if (items.length === 0) {
        return { code: 'NO_VALID_ITEMS', message: 'No valid ticket items found' };
    }

    const itemIds = items.map(item => item._id);

    await wixData.insert('logs', {
        phase: 'ticket_query_start',
        data: { itemIds },
        ts: new Date().toISOString()
    });

    const results = await wixData.query("Events/Tickets").hasSome("_id", itemIds).find();

    await wixData.insert('logs', {
        phase: 'ticket_query_result',
        data: { count: results.items.length, items: results.items },
        ts: new Date().toISOString()
    });

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

    const baseSuccess = 'https://www.live-ls.com/thank-you';
    const successQueryParams = new URLSearchParams();
    successQueryParams.set('tid', shortId);
    successQueryParams.set('oid', String(order?._id ?? ''));
    successQueryParams.set('eid', eventId);
    const successUrl = ensureHttps(`${baseSuccess}?${successQueryParams.toString()}`);

    const cartitems = itemsRaw.map(item => ({
        article: item.name || 'Ticket',
        quantity: item.quantity || 1,
        price: Number(centsToDecimal(item.price || 0)),
        amount: Number(centsToDecimal((item.price || 0) * (item.quantity || 1))),
        currency: 'EUR'
    }));

    // Build payment data for myPOS
    const paymentData = {
        amount: Number(amount),
        currency: 'EUR',
        orderid: shortId,
        customeremail: email,
        customerfirstnames: firstName,
        customerfamilyname: lastName,
        customerphone: phone,
        customercountry: country,
        customercity: city,
        customerzipcode: zipCode,
        customeraddress: address,
        note: eventId,
        url_ok: 'https://www.live-ls.com/_functions/myposOk',
        url_cancel: 'https://www.live-ls.com/_functions/myposCancel',
        cartitems: cartitems
    };

    console.log('myPOS createTransaction: paymentData', JSON.stringify(paymentData));

    try {
        await wixData.insert('logs', {
            phase: 'createTransaction_start',
            data: {
                paymentData,
                fullOrderInfo: order // Log full order for deep debugging
            },
            ts: new Date().toISOString()
        });

        // Call backend — now expected to return a real checkout URL with requestID
        const result = await getMyPosCheckoutUrl(paymentData);

        await wixData.insert('logs', {
            phase: 'createTransaction_result',
            data: { result },
            ts: new Date().toISOString()
        });

        console.log('myPOS createTransaction: result', JSON.stringify(result));

        return {
            redirectUrl: result.redirectUrl,
        };
    } catch (error) {
        const errorData = {
            phase: 'createTransaction_error',
            data: {
                paymentData,
                errorMessage: error.message,
                errorStack: error.stack
            },
            ts: new Date().toISOString()
        };

        if (error.message.includes('database') || error.message.includes('collection')) {
            errorData.data.errorType = 'database_name_error';
        }

        await wixData.insert('logs', errorData);
        throw error;
    }
};

export const refundTransaction = async (options, context) => { };