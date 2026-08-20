-- 0052 — the firm's own client account carries its bank identifiers, for the
-- payment requisition's payer side.
--
-- A printed payment requisition names the payee's bank details (0050) but not
-- the account the money leaves FROM — the firm's own client account at the
-- bank. The person making the transfer, and the file the requisition lands
-- on, need both sides. The account row held only a display name.
--
--   bank_identifiers  jsonb — {"bank","branch_code","account_number",
--                     "account_name"} as the bank states them. Free of any
--                     format rule here: identifier shapes are a country
--                     concern (the pack's bank.account_identifiers rule point
--                     names the shape; Australia's is BSB + account number).
--                     Printed on requisitions; nothing computes from it.
--
-- Nullable; nothing existing changes shape. Accounts recorded before this
-- change print "not recorded" until the identifiers are filled in.

alter table deedbox.client_account
  add column if not exists bank_identifiers jsonb;
