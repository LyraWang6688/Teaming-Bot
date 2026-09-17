-- 为 meeting_records 增加 analysis_zone 字段
-- 设计动机：
--   1. Supabase 是唯一真相源，Base 是展示镜像
--   2. Base「会议状态」单选字段需要直接读 Supabase 的 zone 枚举
--   3. 原先 zone 只嵌套在 analysis_result.teamState.zone 里，Base 同步需多一层 JSON 解析
--   4. 提取为独立列后，便于直接查询、索引和持久化层写入

-- 1) 加列（nullable，兼容存量数据）
alter table meeting_records
  add column if not exists analysis_zone text;

-- 2) 回填存量数据：从 analysis_result.teamState.zone 提取
--    只回填 status='completed' 且 analysis_result 有值的行
update meeting_records
  set analysis_zone = (analysis_result->'teamState'->>'zone'),
      updated_at = now()
  where analysis_result is not null
    and analysis_result->'teamState'->>'zone' is not null
    and analysis_zone is null;
