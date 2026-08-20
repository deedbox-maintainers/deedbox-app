-- 0039: the browser image-OCR panel's write path. document_version_text
-- gains method 'ocr' — text recognised in the reader's own browser from a
-- scanned file and posted back. 'embedded' stays text the file itself
-- carried; 'none' stays the honest empty. A CHECK swap on a text column,
-- not an enum addition, so it is safe inside one file (the 0037 lesson
-- applies only to ALTER TYPE ... ADD VALUE).

alter table deedbox.document_version_text
  drop constraint document_version_text_method_check;
alter table deedbox.document_version_text
  add constraint document_version_text_method_check
  check (method in ('embedded','none','ocr'));
