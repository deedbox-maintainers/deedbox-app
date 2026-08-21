-- 0059 -- fifteen help articles, promoted from live experience.
--
-- Fifteen product topics the engine's own shipped articles did not cover:
-- held money applied to bills, billing holds, client-money statements, bill
-- corrections, disbursements and rates, incidents and refusals, matter
-- visibility, workflows, the office books, reading client-money ledgers,
-- set-asides, tasks and critical dates, top-up requests, transfers, and
-- where the old reports went. The articles carry no firm reference: they
-- describe the product. Promoted here as engine release content, published,
-- exactly like 0036's own set.
--
-- Idempotent: each seed skips a slug the engine set already carries.

create or replace function pg_temp.seed_article(
    p_slug text, p_title text, p_summary text, p_module text,
    p_steps jsonb, p_warning text, p_routes text[], p_related text[],
    p_needs text default null)
returns void language plpgsql as $$
declare
  aid bigint;
  chunk text;
  i integer;
begin
  if exists (select 1 from deedbox.assistant_article where firm is null and slug = p_slug) then
    raise notice 'engine article % already present -- skipped', p_slug;
    return;
  end if;
  insert into deedbox.assistant_article
    (origin, firm, slug, title, summary, module, steps, warnings, routes,
     related, needs_capability, status, product_version, last_verified)
  values
    ('engine', null, p_slug, p_title, p_summary, p_module, p_steps, p_warning,
     p_routes, p_related, p_needs, 'published', 'v1', current_date)
  returning id into aid;
  chunk := p_summary;
  if jsonb_array_length(p_steps) > 0 then
    chunk := chunk || chr(10) || 'Steps:';
    for i in 0 .. jsonb_array_length(p_steps) - 1 loop
      chunk := chunk || chr(10) || (i + 1)::text || '. ' || (p_steps ->> i);
    end loop;
  end if;
  if p_warning is not null then
    chunk := chunk || chr(10) || 'Note: ' || p_warning;
  end if;
  insert into deedbox.assistant_chunk (article, chunk_index, heading, content, routes)
  values (aid, 0, p_title, chunk, p_routes);
end $$;

select pg_temp.seed_article(
  $kbs$applying-held-money-to-bills$kbs$, $kbt$Applying held client money to bills$kbt$,
  $kbm$Paying the firm's bills out of client money you already hold — the preview run, the per-bill transfer payments it creates, and the approval each one must pass before any money moves.$kbm$,
  $kbo$billing$kbo$,
  $kbj$["Open Billing, then Held funds → bills. The screen is called \"Apply held client money to bills\".", "Preview a run first — the preview moves nothing. It lists what could be applied: matters where held client money and unpaid bills sit together. You can narrow it to one matter with the Matter # box.", "Commit the run. For each item this drafts one transfer payment — the firm's costs transfer out of the client account — and sends it into the ordinary client-money approval queue.", "Approvals happen under Client money, then Payments & authorisations, exactly like any other client-money payment: the approver can never be the person who requested it, and at or above the firm's threshold a second approver is required.", "When an item's approvals complete, everything lands in one act: the client-money payment executes AND the bill is paid and allocated on the billing side. Nothing half-happens.", "Past runs stay listed under Runs, item by item, with the outcome of each."]$kbj$::jsonb,
  $kbw$Each application is its own payment through the approval ceremony, so one problem item never holds up the rest. Once a run's transfers have completed, the run page offers a single consolidated EFT requisition — one form covering every completed transfer, with the total and an itemised list per matter — and, where the firm's country pack declares bank-file accounts, the bank payment file for the batch. An item the engine refuses (for example, the money is earmarked or the ledger would go below zero) blocks on its own and is recorded on the refusal register; the other items proceed independently. Money that is set aside (earmarked) is never available to this screen. The assistant cannot run, commit or approve anything for you.$kbw$,
  array[$kbr$/billing/held-funds$kbr$, $kbr$/money/payments$kbr$, $kbr$/matters/:id/money$kbr$]::text[],
  '{}'::text[],
  $kbn$money.apply_held_funds$kbn$);

select pg_temp.seed_article(
  $kbs$billing-hold$kbs$, $kbt$Placing a billing hold$kbt$,
  $kbm$Keeping a matter out of billing runs while work continues — placing the hold, what it does and does not stop, and releasing it.$kbm$,
  $kbo$billing$kbo$,
  $kbj$["Open the matter, then its Billing tab, and find \"Place a billing hold\".", "Enter the Reason — it is always recorded — and place the hold.", "While held, billing runs skip the matter and say so: the run's results itemise it as excluded with the reason \"billing hold\". Work keeps accruing as unbilled items in the meantime.", "Release the hold from the same panel when the matter is ready to bill; the next run picks it up again if it has unbilled work.", "A hold does not stop someone deliberately drafting a bill from the matter itself — a deliberate act on that file remains possible.", "A hold does not touch bills already issued: reminders on existing unpaid bills continue unless held on the bill itself (see the built-in article \"Payment reminders and instalment arrangements\")."]$kbj$::jsonb,
  $kbw$The reason is permanent record, so write one a colleague will understand in a year. If a matter is missing from a billing run, check this panel before anything else — the run's own exclusion list will already have named it. The assistant cannot place or release a hold for you.$kbw$,
  array[$kbr$/matters/:id/billing$kbr$, $kbr$/billing/runs$kbr$]::text[],
  '{}'::text[],
  null);

select pg_temp.seed_article(
  $kbs$client-money-statements$kbs$, $kbt$Client-money statements (including year-end)$kbt$,
  $kbm$Producing the statement of a client's money for a period — generating it from a ledger, checking it, and issuing it once.$kbm$,
  $kbo$money$kbo$,
  $kbj$["Open Client money, then Client statements.", "Generate: enter the Ledger # and the Period start and Period end, then Generate. (A matter's ledger numbers are on its Money tab, which also carries its own Client statements panel.)", "The statement appears in the Statements list. Review it before it goes anywhere.", "Issue it with \"Issue once\". Issuing is a single, recorded act — the issued statement is the permanent record of what the client was told.", "For year-end, generate statements ledger by ledger for the financial-year period. Work from the ledger listings report to see every ledger with a balance, so none is missed."]$kbj$::jsonb,
  $kbw$A statement issues once — that is the point of the button's name. Check the period and the ledger before issuing, because the issued document is kept as-is. The old system's one-click "bulk run for every matter at FY end" does not exist as a single button here; year-end is worked through the ledger list. Statement deadlines are a professional-compliance matter for the principal — your jurisdiction may set them, and the assistant cannot advise on them.$kbw$,
  array[$kbr$/money/statements$kbr$, $kbr$/matters/:id/money$kbr$]::text[],
  '{}'::text[],
  $kbn$money.issue_statements$kbn$);

select pg_temp.seed_article(
  $kbs$correcting-a-bill$kbs$, $kbt$Correcting a bill: credit notes and write-offs$kbt$,
  $kbm$What to do when an issued bill is wrong: credit notes, write-offs, what each does, and why an issued bill can never be cancelled.$kbm$,
  $kbo$billing$kbo$,
  $kbj$["Open the bill (from the matter's Billing tab or Billing, then Unpaid bills).", "To reduce what the client owes because the bill overcharged: in Credits & write-off, enter the Credit note amount and the Reason, and raise the credit note.", "To give up collecting the rest: enter the Write off amount and the Reason. Both are capped at what is outstanding — neither can turn a bill negative.", "Read the bill's journal — every movement, in order: issue, payments, credits, write-offs, interest and disputes all appear as their own entries, so the arithmetic is always visible.", "If the client disputes the bill, record the dispute — reminders stop automatically while it is open and resume on resolution."]$kbj$::jsonb,
  $kbw$An issued bill NEVER changes and can never be un-issued. The old system's action that cancelled a bill and returned its time to the unbilled pool has no equivalent here: corrections are new entries (credit notes, write-offs), each permanent, each with its recorded reason, and a mistaken credit note is itself corrected by a reversal entry, not an edit. Catch problems at the draft stage: a draft can be edited or abandoned freely; issue is the point of no return. These entries have accounting consequences — be sure before confirming. The assistant cannot raise, credit or write off anything for you.$kbw$,
  array[$kbr$/billing/bills/:id$kbr$, $kbr$/billing/unpaid$kbr$]::text[],
  '{}'::text[],
  null);

select pg_temp.seed_article(
  $kbs$disbursements-and-cost-types$kbs$, $kbt$Disbursements, cost types and charge rates$kbt$,
  $kbm$Recording an expense (disbursement) on a matter, how its tax treatment is set, and where staff charge rates and cost types are managed.$kbm$,
  $kbo$billing$kbo$,
  $kbj$["Open the matter, then its Billing tab, and find Unbilled work.", "Add the item with Item kind set to Disbursement: enter the Date it was incurred, a Description, the Amount, and the Tax treatment. The tax treatments on offer come from your country pack, so the tax handling is chosen, not calculated by hand.", "Pick the cost type where one applies — cost types are the firm's categories for recurring expenses, managed under Billing, then Rates & cost types.", "The disbursement now counts as unbilled work on the matter and flows onto the next draft bill exactly like time.", "Charge rates live on the same Rates & cost types screen: Staff charge rates (each with a Label, an hourly Rate and the date it applies From) and Matter rate overrides for a matter that charges differently. Time entries pick up the applicable rate when captured."]$kbj$::jsonb,
  $kbw$A disbursement cannot be added to a closed or archived matter. Choose the Tax treatment deliberately — it drives the tax on the bill line. Rates changes apply from their From date forward; they never rewrite the value of work already recorded. The assistant cannot record a disbursement or change a rate for you.$kbw$,
  array[$kbr$/matters/:id/billing$kbr$, $kbr$/billing$kbr$, $kbr$/billing/rates$kbr$]::text[],
  '{}'::text[],
  null);

select pg_temp.seed_article(
  $kbs$incidents-and-refusals$kbs$, $kbt$Deficiency incidents and the refusal register$kbt$,
  $kbm$Where serious client-money events live now: the deficiency-incident record with its notification, and the permanent register of operations the engine refused.$kbm$,
  $kbo$money$kbo$,
  $kbj$["Open Client money, then Incidents, to see deficiency incidents — events where client money was found deficient. Each incident carries its details and, where notification is required, a \"Generate the notification\" action produces the document.", "Open Client money, then Refusal register, to see every operation the engine refused — attempts that would have overdrawn a ledger, eaten into a set-aside, or otherwise broken the rules. An empty screen says so plainly: the exception register is clean.", "Read a refusal to see what was attempted, by whom, and the typed reason it was refused.", "Reconciliation exceptions are separate: anything unmatched during a reconciliation becomes a typed exception that carries forward in the reconciliation workspace until resolved (see the built-in article \"Reconciling and closing a period\")."]$kbj$::jsonb,
  $kbw$Nothing on either screen can be edited or deleted — refusals and incidents are permanent records by design. The old "Overdrawn ledger" screen has no equivalent because an overdrawn ledger cannot exist here: the engine refuses the transaction at the moment of the attempt instead of recording a negative balance for someone to find later. Whether an incident requires an external report is a professional and compliance judgment for the principal; the assistant can explain the screens but never that.$kbw$,
  array[$kbr$/money/incidents$kbr$, $kbr$/money/refusals$kbr$]::text[],
  '{}'::text[],
  $kbn$money.manage_incidents$kbn$);

select pg_temp.seed_article(
  $kbs$matter-visibility-and-restriction$kbs$, $kbt$Who can see a matter, and why one might be missing$kbt$,
  $kbm$The three things that decide matter visibility — the firm's staff-scope setting, the matter's staffing, and any restriction — and how to fix "I can't see the matter".$kbm$,
  $kbo$matters$kbo$,
  $kbj$["Understand the firm default first: a firm setting (the staff visibility policy) decides who sees UNRESTRICTED matters — everyone, your office, or only those assigned. Ask an administrator which policy your firm runs.", "If the firm scopes by assignment or office and a matter is missing, staffing is the usual fix: on the matter's Staffing page, responsibility can be handed to someone and others added as assisting. Past staffing stays on record.", "If the matter is RESTRICTED, only the people and roles on its restriction list see it at all. The matter's Restriction page shows \"Who can see this matter right now\".", "Changing a restriction is a two-step act: propose the change (grants or blocks), read the visibility delta — exactly who gains and loses sight — and only then commit, with a Reason that is always recorded.", "A restricted matter still leaves honest traces where the law of the firm needs them: a conflict check that hits one reports its existence only, telling you whom to ask."]$kbj$::jsonb,
  $kbw$If a section or matter is simply absent from your screen, that is the permission system working, not an error. The client directory is a separate question: people and organisations are visible firm-wide even when their matters are not. Neither the assistant nor anyone else can show you a matter your visibility does not allow — ask the responsible lawyer or an administrator to staff you on it or adjust the restriction.$kbw$,
  array[$kbr$/matters/:id/restriction$kbr$, $kbr$/matters/:id/staffing$kbr$, $kbr$/matters$kbr$]::text[],
  '{}'::text[],
  null);

select pg_temp.seed_article(
  $kbs$matter-workflow$kbs$, $kbt$Working a matter's workflow: stages and their tasks$kbt$,
  $kbm$Applying a workflow template to a matter, moving through its stages, and how stage tasks and due dates behave.$kbm$,
  $kbo$matters$kbo$,
  $kbj$["Open the matter, then its Workflow tab. A matter with no workflow says so: apply a template or just add tasks.", "Apply a template: pick it from the Template picker. The matter receives the template's stages and their tasks as its own copies.", "Work the stages in order; mark a stage Complete when its work is done and the workflow moves on.", "Task due dates can be derived, not just typed: a task's due rule can anchor to entering the stage or to a defined date (including dates your country pack declares), so applying a template lays out the timeline automatically.", "Add extra tasks freely alongside the template's (New task, Owner, optional Due) — a workflow is a starting shape, not a cage."]$kbj$::jsonb,
  $kbw$A template is a copy source: once applied to a matter, the matter's stages and tasks are its own — later edits to the template affect future applications only, and deactivating a template never touches matters already using it. Authoring templates is not done on this screen (it is an administrator concern outside the matter); applying and working them is. The assistant cannot apply a template, complete a stage or change a due date for you.$kbw$,
  array[$kbr$/matters/:id/workflow$kbr$]::text[],
  '{}'::text[],
  null);

select pg_temp.seed_article(
  $kbs$office-books$kbs$, $kbt$Firm accounts (the office books)$kbt$,
  $kbm$The firm's own accounting — separate from client money: what the Firm accounts section covers, its switched-on state, the practice bridge, bank reconciliation, supplier bills and the financial reports.$kbm$,
  $kbo$finance$kbo$,
  $kbj$["Open Firm accounts, then Office books (visible only to those who operate the firm's books). The home page shows whether the module is switched on — while it is not, nothing posts — and the Doors into each area.", "The Practice bridge carries the practice's own figures (bills, collections) into the books; \"Run the bridge now\" brings it up to date on demand.", "Bank reconciliation: set up the bank accounts (name, chart code, kind), then import the bank statement as a CSV — map the Date, Amount and Description columns — and work the lines.", "Supplier bills: record what the firm owes with New bill — the Contact, their bill number, the bill date and the due date, and the lines.", "Journals, the chart of accounts and finance contacts (the suppliers and others the firm pays) each have their own page in the section; settings for the books live under Finance settings.", "Financial reports: run the firm's accounting reports from Firm accounts, then Financial reports."]$kbj$::jsonb,
  $kbw$Firm accounts and Client money are strictly separate worlds — client money never appears in the office books, and this section can never touch a client ledger. Three things the OLD finance module did are NOT here: tax-return preparation, payroll import and consultant payments — those jobs now live outside this application entirely (payroll stays in the external payroll system; tax lodgement works from the firm's accounting records). The assistant can explain the screens but cannot post, reconcile, pay or run anything for you.$kbw$,
  array[$kbr$/finance$kbr$, $kbr$/finance/reconcile$kbr$, $kbr$/finance/bills$kbr$, $kbr$/finance/reports$kbr$, $kbr$/finance/journals$kbr$, $kbr$/finance/accounts$kbr$, $kbr$/finance/contacts$kbr$, $kbr$/finance/settings$kbr$]::text[],
  '{}'::text[],
  $kbn$gl.manage$kbn$);

select pg_temp.seed_article(
  $kbs$reading-client-money-ledgers$kbs$, $kbt$Reading client-money ledgers, accounts and registers$kbt$,
  $kbm$Where to see client-money balances and the transactions behind them: the accounts view, a matter's ledgers, a single ledger's entries, the receipts list, and the statutory registers.$kbm$,
  $kbo$money$kbo$,
  $kbj$["Open Client money, then Accounts, for the client accounts and the reconciliation workspace — the firm-wide starting point.", "For one matter: open the matter's Money tab. It shows the matter's Ledgers (a ledger can be opened on an account, and closed only when it stands at exactly zero), its Set-asides, Entitlements, Recent movements, Outstanding instruments (cheques and the like not yet presented) and Client statements.", "For one ledger: open it to see every entry, in order — the complete story of that ledger.", "For money in: Client money → Record receipt records it; the Client-money receipts list is the searchable record of receipts.", "For the old cashbook and trial-balance questions, use the report catalogue: the client-money receipts-and-payments report is the cashbook's successor, and the ledger listings report lists every ledger with its balance (see \"Where the old reports went\").", "Statutory registers (Client money → Statutory registers) hold whatever additional registers your jurisdiction's country pack declares; entries are appended and validated against the pack's own rules."]$kbj$::jsonb,
  $kbw$Everything here displays; nothing posts. A ledger can never show a negative balance — an operation that would cause one is refused at the moment of the attempt (see "Deficiency incidents and the refusal register"). The assistant cannot open, export or append anything for you.$kbw$,
  array[$kbr$/money$kbr$, $kbr$/matters/:id/money$kbr$, $kbr$/money/ledgers/:id$kbr$, $kbr$/money/registers$kbr$, $kbr$/money/receipts$kbr$]::text[],
  '{}'::text[],
  $kbn$money.manage_accounts$kbn$);

select pg_temp.seed_article(
  $kbs$set-asides-earmarks$kbs$, $kbt$Set-asides (earmarks): holding client money for a purpose$kbt$,
  $kbm$Quarantining part of a matter's client money so nothing can spend it — creating a set-aside, what it blocks, and releasing it when the purpose is met.$kbm$,
  $kbo$money$kbo$,
  $kbj$["Open the matter, then its Money tab, and find \"Set-asides (earmarks)\".", "Create one: pick the Ledger, enter the Amount and the Purpose. The purpose is the record of why this money is being held.", "While the set-aside stands, that amount is excluded from the matter's available money: payments, transfers and held-funds-to-bills applications that would eat into it are refused outright, and the refusal is recorded.", "Release the set-aside when the purpose is met, and the money returns to available.", "The tab's Entitlements panel is the other half of the picture: an entitlement records a right to take held money (for example against a rendered bill). Set-asides hold money back; entitlements let it be taken."]$kbj$::jsonb,
  $kbw$Available money everywhere in the application — top-up policies, payments, the held-funds bridge — means the ledger balance minus active set-asides. If a payment is refused for cover, check this panel first. Whether money should be set aside or released is a professional and compliance judgment for the responsible people; the assistant can explain the screen but never that.$kbw$,
  array[$kbr$/matters/:id/money$kbr$]::text[],
  '{}'::text[],
  null);

select pg_temp.seed_article(
  $kbs$tasks-and-critical-dates$kbs$, $kbt$My tasks, critical dates and the confirmation queue$kbt$,
  $kbm$Where your to-dos live, where the firm's key dates live, and the queue where the application asks a person to confirm date and assignment changes before they happen.$kbm$,
  $kbo$matters$kbo$,
  $kbj$["Open Work, then My tasks, for everything assigned to you across all matters. An empty list says so plainly.", "Add a task on the matter: the matter's Workflow tab has the Tasks panel — New task, an Owner, an optional Due date, then Add task. Complete tasks from the same panel or from My tasks.", "Open Work, then Critical dates, for the firm's key dates — the deadlines that must not be missed, drawn from matters' key dates.", "Open Work, then Awaiting confirmation, when the application proposes changes rather than making them: date recomputations (something moved an anchor date, so dependent dates need re-deriving) and assignment re-resolutions wait there for a person to confirm. Nothing changes until confirmed.", "Outlook calendar events for a matter are a separate instrument — see the built-in article \"Email and calendar on a matter\"."]$kbj$::jsonb,
  $kbw$Critical dates and tasks are different instruments: a task is work someone owns; a critical date is a deadline the firm watches. The confirmation queue exists so nothing recomputes silently — an unconfirmed proposal means the dependent dates have NOT moved yet, so do not assume a recompute happened. The assistant cannot add, complete or confirm anything for you.$kbw$,
  array[$kbr$/tasks$kbr$, $kbr$/dates$kbr$, $kbr$/proposals$kbr$, $kbr$/matters/:id/workflow$kbr$]::text[],
  '{}'::text[],
  null);

select pg_temp.seed_article(
  $kbs$top-up-requests$kbs$, $kbt$Top-up requests: asking the client for money into the client account$kbt$,
  $kbm$How the application asks a client to top up the money held for their matter: the money-on-hand policy on the matter, the request with its payment reference, and the automatic satisfaction when the money arrives.$kbm$,
  $kbo$billing$kbo$,
  $kbj$["Set the policy on the matter: open the matter's Billing tab and find \"Money on hand policy\". Set the Minimum (the level that triggers a request) and the Target (the level the request asks the client to restore).", "Choose how requests go out: tick \"Issue requests automatically\" for hands-off operation, and \"Attach the request to the next bill\" if you want it to travel with billing.", "When the matter's available client money falls below the Minimum, exactly one request is created and the responsible lawyer is alerted. One shortfall never produces two requests.", "Open Billing, then Top-up requests, to see requests waiting. \"Confirm & issue\" issues one — it carries a unique payment reference for the client to quote.", "When a client-money receipt arrives carrying that reference, the request is satisfied automatically — nothing to match by hand.", "The policy re-arms only once the matter's available money has recovered to at least the Minimum, so it never nags a client twice for the same shortfall."]$kbj$::jsonb,
  $kbw$"Available" means the money actually usable: the ledger balance minus anything set aside (earmarked). If a matter seems to ask for a top-up while money sits on the ledger, check its set-asides on the Money tab. The assistant cannot set a policy, issue a request or receipt money for you.$kbw$,
  array[$kbr$/billing/top-ups$kbr$, $kbr$/matters/:id/billing$kbr$]::text[],
  '{}'::text[],
  null);

select pg_temp.seed_article(
  $kbs$transfers-between-ledgers$kbs$, $kbt$Transferring client money between ledgers$kbt$,
  $kbm$Moving client money from one matter's ledger to another — the old "trust journal" — now a two-step ceremony: authorise the intent first, then execute quoting the authorisation number.$kbm$,
  $kbo$money$kbo$,
  $kbj$["Open Client money, then Transfers.", "Step 1 — Authorise the intent: enter the From ledger #, the To ledger #, the Amount and the Reason, and choose \"Authorise intent\". The reason is always recorded.", "Step 2 — Execute. Use the \"Execute (same account)\" panel when both ledgers sit in the same client account, or \"Execute (across accounts)\" when they do not. Either way you quote the Authorisation # from step 1 — an execution without a matching authorisation is refused.", "The movement lands on both ledgers and shows in each matter's Money tab under recent movements."]$kbj$::jsonb,
  $kbw$The split between authorising and executing is deliberate: the same rules as payments apply, so one person cannot invent and complete a transfer alone. A transfer can never overdraw the source ledger or eat into money that is set aside (earmarked) — the engine refuses it and the refusal is recorded permanently. Whether moving money between two matters is proper is a professional judgment; the assistant can explain the screen but never that.$kbw$,
  array[$kbr$/money/transfer$kbr$]::text[],
  '{}'::text[],
  $kbn$money.record_payment$kbn$);

select pg_temp.seed_article(
  $kbs$where-the-old-reports-went$kbs$, $kbt$Where the old reports went$kbt$,
  $kbm$The lookup from each report you used in the old system to the standard report that answers the same question in the new catalogue, and how the new viewer's shaping replaces the old fixed layouts.$kbm$,
  $kbo$reports$kbo$,
  $kbj$["Open Reports, then the catalogue, and run the report that matches your old question: - Old **Aged Debtors** → the aged receivables report [`aged_receivables`]: outstanding issued bills in age bands. - Old **Unbilled WIP** → the aged unbilled-work report [`unbilled_work_aged`]. (Amending a narrative now happens on the entry itself — narratives stay writable even after billing.) - Old **Matter Financial Summary** → the matter-list financials report [`matter_list_financials`]. It supports own-figures scope: without firm-wide reporting permissions you automatically see only your own matters, as before. - Old **Practitioner summary** → the staff performance report [`staff_performance`]. - Old **Invoicing report** → the billing activity report [`billing_activity`], over the bills' journal entries. - Old **Trust trial balance** → the ledger listings report [`ledger_listings`]: every ledger with its balance. - Old **Trust cashbook** → the client-money receipts-and-payments report [`client_money_receipts_payments`].", "Shape it in the viewer: set the period, filter by Practice area or Office, and choose Group by (and Then by); subtotals follow the grouping.", "Save a shaped report to keep it with its filters; it appears under Saved reports.", "Schedule it (Every / Format / Recipient) to send on a cadence — each recipient receives only what their own permissions allow.", "Export from the viewer when you need the file; exports are recorded in Export history."]$kbj$::jsonb,
  $kbw$The old fixed layouts do not exist — the same figures come out of the catalogue plus your own grouping, which is why saving a shaped report matters: it is how the firm re-creates its standard views. Two old reports have NO successor here: the Debt Recovery report (chasing is now the reminder sequence — see the built-in article "Payment reminders and instalment arrangements") and the Receivables/Fee Distribution report (the firm's fee-split arrangement outlives the software, but this application does not compute it). Firm-wide financial figures need the reporting permissions; without them reports show your own figures only. The assistant cannot run, save or schedule a report for you.$kbw$,
  array[$kbr$/reports$kbr$, $kbr$/reports/:key$kbr$, $kbr$/reports/schedules$kbr$]::text[],
  '{}'::text[],
  null);
