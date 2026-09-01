create index if not exists knowledge_documents_base_created_at_idx
on public.knowledge_documents (organization_id, knowledge_base_id, created_at desc);
