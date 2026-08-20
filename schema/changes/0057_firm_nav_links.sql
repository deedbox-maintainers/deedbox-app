-- 0057 — the navigation learns a firm's own doors.
--
-- An installation can carry screens the shipped product does not know about:
-- private-layer pages, instance tooling, a firm's own reports. Until now the
-- only ways to reach them were bookmarks and links in emails — invisible from
-- the menu, which is where people look. The private-layer settings door
-- already exists; this gives such screens a place in the navigation itself.
--
-- One firm setting, `nav.firm_links`: plain text, one link per line,
--
--     Section | Label | /path | capability,capability
--
-- The section names an existing menu group (the link joins it) or a new one
-- (appended after the shipped groups). Capabilities are optional and filter
-- display exactly like the shipped items — display-only convenience; every
-- screen keeps checking for itself. Paths must be internal (begin with '/').
-- Malformed lines are ignored: the menu must never break the shell.
--
-- The neutral default is empty — an installation that sets nothing sees
-- exactly the menu it always had. Changing the setting is register-logged
-- like every setting change.

insert into deedbox.setting_definition (key, value_type, neutral_default, allowed_values, description) values
('nav.firm_links', 'text', '""', null,
 'Extra navigation links for this installation''s own screens. One per line: '
 'Section | Label | /path | capability,capability (capabilities optional). '
 'The section joins an existing menu group by name or appears as a new group. '
 'Paths must be internal (start with /). Display-only: every screen still '
 'checks its own permissions.');
