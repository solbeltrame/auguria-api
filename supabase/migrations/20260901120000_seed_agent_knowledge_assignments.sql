insert into public.agent_knowledge_bases (
  organization_id,
  agent_id,
  knowledge_base_id
)
select
  agents.organization_id,
  agents.id,
  knowledge_bases.id
from public.agents
join public.knowledge_bases
  on knowledge_bases.organization_id = agents.organization_id
 and knowledge_bases.status = 'active'
where agents.user_id is null
  and agents.deleted_at is null
on conflict (agent_id, knowledge_base_id) do nothing;
