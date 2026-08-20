-- 0048 — one-person client-money operation becomes a firm's own choice.
--
-- The engine shipped separation of duties as an unconditional rule: the
-- requester never authorises their own payment, and the authoriser never
-- executes their own approval. That is a control worth having — but no law
-- requires two humans (sole practitioners lawfully operate client-money
-- accounts alone everywhere), and as a hard rule it makes the product
-- unusable for a practice operated by one person.
--
-- So the separation family becomes a firm setting. OFF (the neutral
-- default) keeps every wall exactly as shipped. ON, one person may raise,
-- authorise and execute a payment alone — with every step still recorded on
-- the register under their name, and the act of changing the setting itself
-- register-logged like every setting change. Multi-approval distinctness is
-- untouched: where a payment demands two authorisations, they remain two
-- different people regardless of this setting.

insert into deedbox.setting_definition (key, value_type, neutral_default, allowed_values, description) values
('money.self_authorisation', 'boolean', 'false', null,
 'Whether one person may raise, authorise and execute a client-money payment alone. '
 'Off: every payment needs a second person (separation of duties, the shipped default). '
 'On: a practice operated by one person does all steps under their own name, each step '
 'still recorded on the register.');
