-- migrate:up
-- Migration 024: ledger events for the simulated supplier agent (PayPal Cart
-- API spec). After a hold, server code negotiates the supplier's cart, accepts
-- a substitution only within the owner's rules, and checks the cart out:
--  * cart_negotiated: what the supplier reported and what the rules decided;
--  * supplier_ordered: the supplier's order number after checkout.
-- An accepted substitution replaces supplier_payments.lines (guarded in code:
-- held, nothing charged, within the hold; the UPDATE grant already covers it).
BEGIN;

ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_kind_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_kind_check CHECK (kind IN (
  'policy_evaluated', 'approval_requested', 'approved', 'declined', 'authorized', 'reauthorized',
  'captured', 'voided', 'refunded', 'payout_sent', 'payout_completed', 'failed', 'webhook_received',
  'cart_negotiated', 'supplier_ordered'
));

COMMIT;

-- migrate:down
BEGIN;

DELETE FROM payment_events WHERE kind IN ('cart_negotiated', 'supplier_ordered');
ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_kind_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_kind_check CHECK (kind IN (
  'policy_evaluated', 'approval_requested', 'approved', 'declined', 'authorized', 'reauthorized',
  'captured', 'voided', 'refunded', 'payout_sent', 'payout_completed', 'failed', 'webhook_received'
));

COMMIT;
