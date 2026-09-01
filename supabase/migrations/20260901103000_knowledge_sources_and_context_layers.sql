alter table public.knowledge_bases
  add column if not exists generated_context text not null default '';

alter table public.knowledge_documents
  add column if not exists source_type text not null default 'file';

alter table public.knowledge_documents
  add column if not exists source_url text;

alter table public.knowledge_documents
  add column if not exists active boolean not null default true;

alter table public.knowledge_documents
  alter column storage_path drop not null;

alter table public.knowledge_documents
  drop constraint if exists knowledge_documents_source_type_check;

alter table public.knowledge_documents
  add constraint knowledge_documents_source_type_check
  check (source_type in ('file', 'url'));

alter table public.knowledge_documents
  drop constraint if exists knowledge_documents_source_shape_check;

alter table public.knowledge_documents
  add constraint knowledge_documents_source_shape_check
  check (
    (source_type = 'file' and storage_path is not null and source_url is null)
    or (source_type = 'url' and source_url is not null and storage_path is null)
  );

create index if not exists knowledge_documents_active_idx
on public.knowledge_documents (organization_id, knowledge_base_id, active, status);
