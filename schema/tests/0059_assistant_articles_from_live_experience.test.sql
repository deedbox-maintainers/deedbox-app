-- Tests for 0059_assistant_articles_from_live_experience. Run as deployment
-- role AFTER the full chain: the fifteen promoted articles exist as engine
-- release content, published, each with its retrieval chunk, and none of
-- them collides with 0036's own set.

begin;

do $$
declare
  n int;
  slugs text[] := array[
    'applying-held-money-to-bills','billing-hold','client-money-statements',
    'correcting-a-bill','disbursements-and-cost-types','incidents-and-refusals',
    'matter-visibility-and-restriction','matter-workflow','office-books',
    'reading-client-money-ledgers','set-asides-earmarks','tasks-and-critical-dates',
    'top-up-requests','transfers-between-ledgers','where-the-old-reports-went'];
begin
  -- T1: all fifteen exist as published engine articles
  select count(*) into n from deedbox.assistant_article
   where origin = 'engine' and firm is null and status = 'published'
     and slug = any(slugs);
  if n <> 15 then
    raise exception 'T1 FAILED: expected 15 published engine articles, found %', n;
  end if;

  -- T2: each carries its retrieval chunk
  select count(*) into n
    from deedbox.assistant_article a
    join deedbox.assistant_chunk c on c.article = a.id
   where a.firm is null and a.slug = any(slugs);
  if n < 15 then
    raise exception 'T2 FAILED: expected a chunk per article, found %', n;
  end if;

  -- T3: the promotion created no firm-origin rows
  select count(*) into n from deedbox.assistant_article
   where origin = 'firm' and slug = any(slugs);
  if n <> 0 then
    raise exception 'T3 FAILED: % firm-origin rows carry promoted slugs on a fresh chain', n;
  end if;

  -- T4: nothing in the promoted content names a country's tax vocabulary —
  -- the articles describe the product; country wording is the pack's job
  select count(*) into n from deedbox.assistant_article
   where firm is null and slug = any(slugs)
     and (title || ' ' || summary || ' ' || steps::text || ' ' || coalesce(warnings, ''))
         ~* '(\yGST\y|\yBAS\y|\yVAT\y|\yBSB\y|Tax Invoice)';
  if n <> 0 then
    raise exception 'T4 FAILED: % promoted articles carry country tax vocabulary', n;
  end if;
end $$;

rollback;
