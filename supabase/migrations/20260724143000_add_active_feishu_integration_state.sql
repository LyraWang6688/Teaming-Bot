alter table if exists public.feishu_integrations
  add column if not exists is_active boolean not null default false,
  add column if not exists activated_at timestamp with time zone,
  add column if not exists superseded_at timestamp with time zone,
  add column if not exists superseded_by_integration_id uuid;

create index if not exists feishu_integrations_is_active_idx
  on public.feishu_integrations (is_active);

create index if not exists feishu_integrations_superseded_by_integration_id_idx
  on public.feishu_integrations (superseded_by_integration_id);

with ranked as (
  select
    fi.id,
    first_value(fi.id) over (
      partition by u.feishu_union_id, fi.selected_org_target_id
      order by fi.created_at desc, fi.updated_at desc, fi.id desc
    ) as latest_integration_id,
    row_number() over (
      partition by u.feishu_union_id, fi.selected_org_target_id
      order by fi.created_at desc, fi.updated_at desc, fi.id desc
    ) as row_num
  from public.feishu_integrations fi
  inner join public.users u on u.id = fi.user_id
  where fi.deleted_at is null
    and fi.selected_org_target_id is not null
    and u.feishu_union_id is not null
)
update public.feishu_integrations fi
set
  is_active = ranked.row_num = 1,
  activated_at = case
    when ranked.row_num = 1 then coalesce(fi.activated_at, now())
    else fi.activated_at
  end,
  superseded_at = case
    when ranked.row_num = 1 then null
    else coalesce(fi.superseded_at, now())
  end,
  superseded_by_integration_id = case
    when ranked.row_num = 1 then null
    else ranked.latest_integration_id
  end
from ranked
where fi.id = ranked.id;
