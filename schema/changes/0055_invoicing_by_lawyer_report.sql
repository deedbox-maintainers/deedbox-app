-- 0055: the invoicing-by-lawyer report — every bill issued in a period with
-- its invoiced / received / written-off / owing position and the matter's
-- responsible lawyer, so the viewer's grouping gives per-lawyer subtotals.
-- Firms expect an invoicing report grouped by lawyer, with subtotals and a
-- lawyer filter; the engine had no equivalent, though the figures all
-- exist on the bill journal. Builder: lib/ops/reports/engine.ts.

begin;

insert into deedbox.report_definition
  (key, title, base_record_set, default_columns, available_filters, aggregation,
   visibility_roles, own_figures_scope_supported, category, tile_group, schedulable) values
('invoicing_by_lawyer','report.invoicing_by_lawyer',
 '{"base":"bills issued in period with journal positions"}','[]','[]',
 '{"sum":"invoiced, received, written off, owing"}',
 '["administrator","accounts"]',true,'standard_report',null,true);

commit;
