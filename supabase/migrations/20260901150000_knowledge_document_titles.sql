alter table public.knowledge_documents
  add column if not exists title text;

update public.knowledge_documents
set title = left(btrim(file_name), 160)
where title is null or btrim(title) = '';

alter table public.knowledge_documents
  alter column title set default '';

alter table public.knowledge_documents
  alter column title set not null;

alter table public.knowledge_documents
  drop constraint if exists knowledge_documents_title_check;

alter table public.knowledge_documents
  add constraint knowledge_documents_title_check
  check (length(btrim(title)) between 1 and 160);
