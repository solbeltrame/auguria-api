alter table public.knowledge_bases
  add column if not exists instructions text not null default '';
