import * as paymentProvider from 'interfaces-psp-v1-payment-service-provider';

/** @returns {import('interfaces-psp-v1-payment-service-provider').PaymentServiceProviderConfig} */
export function getConfig() {
    return {
        title: 'Cartão, Apple Pay e Google Pay',
        paymentMethods: [{
            hostedPage: {
                title: 'Cartão, Apple Pay e Google Pay',
                billingAddressMandatoryFields: [],
                // logos: {
                //     white: {
                //         svg: 'https://your-logo-url.com/white-logo.svg',
                //         png: 'https://static.wixstatic.com/media/c5af70_d13da4a1d70b4d41b791af3c388db9a5~mv2.jpeg'
                //     },
                //     colored: {
                //         svg: 'https://static.wixstatic.com/shapes/c5af70_ea66b53635c240fabd312962b888e173.svg',
                //     png: 'https://static.wixstatic.com/media/c5af70_76a2dc69f872407cad3e807804007811~mv2.png'
                //     }
                // }
            }
        }],
        credentialsFields: [{
            simpleField: {
                name: 'myPOS Payments Key',
                label: 'API Key for myPOS Payments'
            }
        }]
    }
}