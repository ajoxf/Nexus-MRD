-- Undoes 0013_statements.sql. Deletes every stored statement — the zips themselves are
-- untouched on the trader's computer and can be opened again.
begin;
drop table if exists public.statements;
commit;
