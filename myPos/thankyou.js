import wixLocation from 'wix-location';
import wixData from 'wix-data';
import { confirmOrder, getOrder } from 'backend/getEvent.web';

$w.onReady(async function () {
    // Hide repeater initially
    $w('#ticketRepeater').hide();

    try {
        // Extract query parameters
        const q = wixLocation.query;
        const tid = q.tid || '';
        const oid = q.oid || '';
        const eid = q.eid || '';

        // Return early if oid and eid are empty
        if (!oid && !eid) {

            $w('#callbackRepeaterText').text = "​Thank you for your purchase!  Tickects will be sent your email .For any questions, please send an email to info@live-ls.com or contact us by phone at 921 460 303."
            return;
        }

        // Confirm order
        let confirmOrderResponse = null;
        try {
            const options = { orderNumber: [oid] };
            confirmOrderResponse = await confirmOrder(eid, options);
        } catch (e) {
            await wixData.insert('logs', {
                phase: 'confirm_order_error',
                data: { msg: e.message, stack: e.stack },
                ts: new Date().toISOString()
            });
            console.error('Confirm order failed:', e);
        }

        // Get order details
        let getOrderResponse = null;
        const identifiers = {
            eventId: eid,
            orderNumber: oid
        };
        const options1 = {
            fieldset: ["TICKETS", "DETAILS"]
        };
        try {
            getOrderResponse = await getOrder(identifiers, options1);

        } catch (e) {

            console.error('Get order failed:', e);
            throw new Error('Failed to retrieve order details');
        }

        // Prepare repeater data
        const repeaterData = getOrderResponse.map(ticket => ({
            ...ticket,
            qrCode: ticket.qrCode || '',
            checkInUrl: ticket.checkInUrl || '',
            walletPassUrl: ticket.walletPassUrl || ''
        }));

        // Bind to repeater
        $w('#ticketRepeater').data = repeaterData;
        $w('#ticketRepeater').onItemReady(($item, data) => {
            $item('#ticketName').text = data.ticketName || '';
            $item('#ticketPrice').text = data.ticketPrice || '';
            $item('#ticketDownloadUrl').link = data.pdfUrl || '';
        });
        $w('#callbackRepeaterText').text = "​Thank you for your purchase! For any questions, please send an email to info@live-ls.com or contact us by phone at 921 460 303."
        // Show repeater
        $w('#ticketRepeater').show();

    } catch (e) {

        console.error('Global error:', e);
    }
});