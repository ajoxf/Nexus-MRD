-- Rollback for 0013 — back to the ledger inside settings.
--
-- settings.data->'cash' was never changed by 0013, so the previous version of the app
-- picks it up exactly where it was. Redeploy that version after running this.
--
-- Entries recorded AFTER 0013 live only in public.cash_entries and are deleted here.
-- If you have used the new version, export them first:
--   select * from public.cash_entries where source_key not like 'legacy:%' order by ts;

begin;
drop table if exists public.cash_entries;
commit;
