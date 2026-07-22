alter table public.feishu_integration_checks
  add column if not exists minute_subscription_status text not null default 'pending';

update public.feishu_integration_checks
set minute_subscription_status = case
  when event_subscription_status = 'success'
    or details #>> '{eventSubscription,minuteChangeSubscription,ok}' = 'true'
    then 'success'
  when details #>> '{eventSubscription,blockedGate}' = 'minute_subscription'
    then 'failed'
  else 'pending'
end;
