create extension if not exists vector with schema extensions;

insert into storage.buckets (id, name, public)
values ('knowledge', 'knowledge', false)
on conflict (id) do nothing;

create table public.knowledge_bases (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  name text not null,
  description text,
  status text default 'active' not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint knowledge_bases_pkey primary key (id),
  constraint knowledge_bases_organization_id_fkey foreign key (organization_id)
    references public.organizations(id) on delete cascade,
  constraint knowledge_bases_created_by_fkey foreign key (created_by)
    references auth.users(id) on delete set null,
  constraint knowledge_bases_status_check check (status in ('active', 'archived')),
  constraint knowledge_bases_name_check check (length(btrim(name)) between 1 and 120)
);

create unique index knowledge_bases_organization_id_id_key
on public.knowledge_bases (organization_id, id);

create unique index knowledge_bases_organization_id_name_key
on public.knowledge_bases (organization_id, lower(name));

create index knowledge_bases_organization_id_idx
on public.knowledge_bases (organization_id, updated_at desc);

create table public.knowledge_documents (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  knowledge_base_id uuid not null,
  file_name text not null,
  mime_type text not null,
  storage_path text not null,
  file_size bigint default 0 not null,
  status text default 'pending' not null,
  extracted_text text,
  error_message text,
  metadata jsonb default '{}'::jsonb not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint knowledge_documents_pkey primary key (id),
  constraint knowledge_documents_organization_id_fkey foreign key (organization_id)
    references public.organizations(id) on delete cascade,
  constraint knowledge_documents_base_fkey foreign key (organization_id, knowledge_base_id)
    references public.knowledge_bases(organization_id, id) on delete cascade,
  constraint knowledge_documents_created_by_fkey foreign key (created_by)
    references auth.users(id) on delete set null,
  constraint knowledge_documents_status_check check (
    status in ('pending', 'processing', 'ready', 'error')
  ),
  constraint knowledge_documents_file_name_check check (length(btrim(file_name)) between 1 and 255),
  constraint knowledge_documents_file_size_check check (file_size >= 0)
);

create unique index knowledge_documents_base_storage_path_key
on public.knowledge_documents (knowledge_base_id, storage_path);

create unique index knowledge_documents_organization_id_id_key
on public.knowledge_documents (organization_id, id);

create index knowledge_documents_organization_id_idx
on public.knowledge_documents (organization_id, created_at desc);

create table public.knowledge_chunks (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  knowledge_base_id uuid not null,
  document_id uuid not null,
  chunk_index integer not null,
  content text not null,
  search_vector tsvector default ''::tsvector not null,
  embedding extensions.vector(1536),
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  constraint knowledge_chunks_pkey primary key (id),
  constraint knowledge_chunks_document_fkey foreign key (organization_id, document_id)
    references public.knowledge_documents(organization_id, id) on delete cascade,
  constraint knowledge_chunks_base_fkey foreign key (organization_id, knowledge_base_id)
    references public.knowledge_bases(organization_id, id) on delete cascade,
  constraint knowledge_chunks_index_check check (chunk_index >= 0)
);

create unique index knowledge_chunks_document_index_key
on public.knowledge_chunks (document_id, chunk_index);

create index knowledge_chunks_organization_id_idx
on public.knowledge_chunks (organization_id);

create index knowledge_chunks_search_idx
on public.knowledge_chunks using gin (search_vector);

create index knowledge_chunks_embedding_idx
on public.knowledge_chunks using hnsw (embedding extensions.vector_cosine_ops);

create or replace function public.set_knowledge_chunk_search_vector()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  new.search_vector := to_tsvector('simple'::regconfig, coalesce(new.content, ''));
  return new;
end
$function$;

create trigger set_knowledge_chunk_search_vector
before insert or update of content on public.knowledge_chunks
for each row
execute function public.set_knowledge_chunk_search_vector();

create table public.agent_knowledge_bases (
  organization_id uuid not null,
  agent_id uuid not null,
  knowledge_base_id uuid not null,
  created_at timestamp with time zone default now() not null,
  constraint agent_knowledge_bases_pkey primary key (agent_id, knowledge_base_id),
  constraint agent_knowledge_bases_agent_fkey foreign key (organization_id, agent_id)
    references public.agents(organization_id, id) on delete cascade,
  constraint agent_knowledge_bases_base_fkey foreign key (organization_id, knowledge_base_id)
    references public.knowledge_bases(organization_id, id) on delete cascade
);

create index agent_knowledge_bases_organization_id_idx
on public.agent_knowledge_bases (organization_id);

create or replace function public.set_knowledge_updated_at()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  new.updated_at = now();
  return new;
end
$function$;

create trigger set_knowledge_bases_updated_at
before update on public.knowledge_bases
for each row
execute function public.set_knowledge_updated_at();

create trigger set_knowledge_documents_updated_at
before update on public.knowledge_documents
for each row
execute function public.set_knowledge_updated_at();

alter table public.knowledge_bases enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.agent_knowledge_bases enable row level security;

create policy "members can read their knowledge bases"
on public.knowledge_bases
for select
to authenticated, anon
using (organization_id in (select public.get_authorized_orgs('member')));

create policy "admins can create knowledge bases"
on public.knowledge_bases
for insert
to authenticated, anon
with check (organization_id in (select public.get_authorized_orgs('admin')));

create policy "admins can update knowledge bases"
on public.knowledge_bases
for update
to authenticated, anon
using (organization_id in (select public.get_authorized_orgs('admin')))
with check (organization_id in (select public.get_authorized_orgs('admin')));

create policy "admins can delete knowledge bases"
on public.knowledge_bases
for delete
to authenticated, anon
using (organization_id in (select public.get_authorized_orgs('admin')));

create policy "members can read their knowledge documents"
on public.knowledge_documents
for select
to authenticated, anon
using (organization_id in (select public.get_authorized_orgs('member')));

create policy "admins can manage knowledge documents"
on public.knowledge_documents
for all
to authenticated, anon
using (organization_id in (select public.get_authorized_orgs('admin')))
with check (organization_id in (select public.get_authorized_orgs('admin')));

create policy "members can read their knowledge chunks"
on public.knowledge_chunks
for select
to authenticated, anon
using (organization_id in (select public.get_authorized_orgs('member')));

create policy "admins can manage knowledge chunks"
on public.knowledge_chunks
for all
to authenticated, anon
using (organization_id in (select public.get_authorized_orgs('admin')))
with check (organization_id in (select public.get_authorized_orgs('admin')));

create policy "members can read agent knowledge links"
on public.agent_knowledge_bases
for select
to authenticated, anon
using (organization_id in (select public.get_authorized_orgs('member')));

create policy "admins can manage agent knowledge links"
on public.agent_knowledge_bases
for all
to authenticated, anon
using (organization_id in (select public.get_authorized_orgs('admin')))
with check (organization_id in (select public.get_authorized_orgs('admin')));

create policy "members can read their knowledge files"
on storage.objects
for select
to authenticated, anon
using (
  bucket_id = 'knowledge'
  and (storage.foldername(name))[1] in (
    select public.get_authorized_orgs('member')::text
  )
);

create policy "admins can upload their knowledge files"
on storage.objects
for insert
to authenticated, anon
with check (
  bucket_id = 'knowledge'
  and (storage.foldername(name))[1] in (
    select public.get_authorized_orgs('admin')::text
  )
);

create policy "admins can update their knowledge files"
on storage.objects
for update
to authenticated, anon
using (
  bucket_id = 'knowledge'
  and (storage.foldername(name))[1] in (
    select public.get_authorized_orgs('admin')::text
  )
)
with check (
  bucket_id = 'knowledge'
  and (storage.foldername(name))[1] in (
    select public.get_authorized_orgs('admin')::text
  )
);

create policy "admins can delete their knowledge files"
on storage.objects
for delete
to authenticated, anon
using (
  bucket_id = 'knowledge'
  and (storage.foldername(name))[1] in (
    select public.get_authorized_orgs('admin')::text
  )
);

grant select on table public.knowledge_bases to anon, authenticated;
grant insert, update, delete on table public.knowledge_bases to anon, authenticated;
grant select on table public.knowledge_documents to anon, authenticated;
grant insert, update, delete on table public.knowledge_documents to anon, authenticated;
grant select on table public.knowledge_chunks to anon, authenticated;
grant insert, update, delete on table public.knowledge_chunks to anon, authenticated;
grant select on table public.agent_knowledge_bases to anon, authenticated;
grant insert, update, delete on table public.agent_knowledge_bases to anon, authenticated;
grant all on table public.knowledge_bases to service_role;
grant all on table public.knowledge_documents to service_role;
grant all on table public.knowledge_chunks to service_role;
grant all on table public.agent_knowledge_bases to service_role;
