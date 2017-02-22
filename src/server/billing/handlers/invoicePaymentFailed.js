import stripe from 'server/billing/stripe';
import getRethink from 'server/database/rethinkDriver';
import shortid from 'shortid';
import {UNPAID, BILLING_LEADER, PAYMENT_REJECTED} from 'universal/utils/constants';
import terminateSubscription from 'server/billing/helpers/terminateSubscription';

/*
 * Used for failed payments that are not trialing. Trialing orgs will not have a CC
 */
export default async function invoicePaymentFailed(invoiceId) {
  const r = getRethink();
  const now = new Date();

  // VALIDATION
  const {amount_due, customer: customerId, metadata: {orgId}, subscription, paid} = await stripe.invoices.retrieve(invoiceId);
  const org = await r.table('Organization').get(orgId).pluck('creditCard', 'stripeSubscriptionId');
  const {creditCard, stripeSubscriptionId} = org;
  /* attack vector #1: call the webhook with the victims invoiceId that was successful
   attack vector #2: call the webhook with the victims old failed invoiceId, causing them to fail again
   once failed, the stripeSubscriptionId will change (id1 -> null -> id2 on success)
   this is better than making sure the webhook was sent just a couple hours ago
   also better than looking up the charge & making sure that there hasn't been a more recent, successful charge*/
  console.log('paid, eq', paid, stripeSubscriptionId, subscription);
  if (paid || stripeSubscriptionId !== subscription) return false;

  // RESOLUTION
  // this must have not been a trial (or it was and they entered a card that got invalidated <1 hr after entering it)
  if (creditCard) {
    console.log('termination');
    const orgDoc = await terminateSubscription(orgId);
    const userIds = orgDoc.orgUsers.reduce((billingLeaders, orgUser) => {
      if (orgUser.role === BILLING_LEADER) {
        billingLeaders.push(orgUser.id);
      }
      return billingLeaders;
    }, []);
    const {last4, brand} = creditCard;
    console.log('updating balance', amount_due);
    await stripe.customers.update(customerId, {
      // amount_due includes the old account_balance, so we can (kinda) atomically set this
      account_balance: amount_due
    });
    console.log('setting unpaid on db');
    await r.table('Invoice').get(invoiceId).update({
      status: UNPAID
    })
      .do(() => {
        return r.table('Notification').insert({
          id: shortid.generate(),
          type: PAYMENT_REJECTED,
          startAt: now,
          orgId,
          userIds,
          varList: [last4, brand]
        });
      });
  }
  return true;
}
