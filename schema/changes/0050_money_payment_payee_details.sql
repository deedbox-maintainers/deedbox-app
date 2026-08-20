-- 0050 — a client-money payment carries where the money goes and how the bank
-- knew it: the payee's bank details, and the bank's own reference.
--
-- The payment document named its payee (a party, or a description) but had
-- nowhere for the details the person making the transfer needs at the bank —
-- the payee's account name, BSB and account number — nor for the bank's own
-- transaction reference once the money has left. Both were being kept outside
-- the record (a paper requisition and a bank screen). Now:
--
--   payee_bank_details  jsonb — {"account_name","bsb","account_number"} as
--                       typed at drafting; free of any format rule here (the
--                       country pack's bank.account_identifiers shape is the
--                       client-account side; a payee's bank is whatever the
--                       payee says it is); printed on the requisition.
--   external_reference  text  — the bank's transaction reference (or the
--                       instrument's), recorded at execution — the moment
--                       the money left — and immutable with the rest of the
--                       executed document.
--
-- Both nullable; nothing existing changes shape. The payment guard (0013) is
-- untouched: a finished document stays immutable, so a reference is written
-- in the same statement that executes.

alter table deedbox.money_payment
  add column if not exists payee_bank_details jsonb,
  add column if not exists external_reference text;
