-- 0056: the firm's standing bill notice — two text settings rendered on
-- every issued bill's document under the payment instructions. Firm-specific
-- wording (funding arrangements, regulatory statements) stays firm DATA:
-- the engine carries the mechanism, never the words. The notice is embedded
-- in each bill's rendering AT ISSUE, so a historic bill keeps exactly the
-- wording it went out with; blank settings render nothing.

begin;

insert into deedbox.setting_definition (key, value_type, neutral_default, allowed_values, description) values
('billing.bill_notice_heading','text','""',null,
 'Optional heading for the firm''s standing notice on issued bills (used only when the notice itself is set).'),
('billing.bill_notice','text','""',null,
 'The firm''s standing notice printed on every issued bill under the payment instructions; embedded in each bill''s rendering at issue. Blank = no notice.');

commit;
