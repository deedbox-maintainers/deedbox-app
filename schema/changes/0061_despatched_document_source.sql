-- 0061: a despatched document is filed where the matter's record lives.
--
-- When the product emails a client a document it built — a bill today — the
-- copy the client received belongs on the matter's file. The sending log
-- proves the despatch happened; the matter's documents hold the paper. The
-- landing record's source vocabulary learns the honest label for that
-- provenance: the file arrived because the product sent it, not because a
-- person uploaded it. A CHECK swap must restate the whole list.

alter table deedbox.document_file drop constraint document_file_source_check;
alter table deedbox.document_file add constraint document_file_source_check
  check (source in ('intake_api','staff_upload','template_generation','signing',
                    'email_filing','import','outbound_despatch'));
