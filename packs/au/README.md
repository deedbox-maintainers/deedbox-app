# Australian country pack

The engine ships jurisdiction-neutral. A **country pack** is a set of typed
declarations against the engine's rule points (see `schema/changes/0002`);
a firm's database holds the pack and its versions, and the engine consults the
firm's **active** version — falling back to the neutral default wherever the
pack is silent.

This folder holds the Australian pack, one file per version. Files are
additive and idempotent: run every file in name order against a firm's
database as the deployment role to install the versions; then activate the
one that should govern.

| Version | Declares |
|---|---|
| `2026.08.19` | `billing.tax` — `standard` (GST 10%) and `gst_free` (no GST) |
| `2026.08.20` | The tax rules carried forward (`standard` now the declared default) + `bank.account_identifiers` (BSB and account number — drives the payment-details and payee captures, and gates the bank-payment-file download) + the Australian document wording: `strings.bill_title` ("Tax Invoice"), `strings.receipt_title` ("Trust Account Receipt"), `strings.registration_label` ("ABN") |

The pack is **national** (`au`) — a deliberate, recorded decision. GST is
federal; Australian client-money law is state law, and any state-specific
declarations will arrive as pack updates rather than as separate per-state
packs.

## Installing

```
psql "$DATABASE_URL" -f packs/au/2026.08.19-billing-tax.sql
```

(or the same SQL through whatever administrative channel the deployment
uses). Installing records the version; nothing changes until activation.

## Activating

Activation is a registered, privileged operation. In the product: Settings →
Country pack → Activate (capability `pack.activate`). From an installer:

```sql
select deedbox.activate_pack(
  (select id from deedbox.country_pack where code = 'au'),
  (select v.id from deedbox.pack_version v join deedbox.country_pack p on p.id = v.pack
    where p.code = 'au' and v.version = '2026.08.19'),
  'staff', <the acting administrator's staff id>);
```

The version governs the moment it is active. For `billing.tax`: bills drafted
from then on carry tax per line at the declared rates; drafts already open
pick the rule up at submission or issue (schema change 0049). Once a pack
declares tax keys, only declared keys are accepted on new disbursements and
cost types — check the firm's existing keys are among them before activating.
