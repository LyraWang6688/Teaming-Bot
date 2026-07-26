import process from 'node:process';
import {
  callFeishuOpenApi,
  createPool,
  extractBitableText,
  listMigrationTargets,
  logMigration,
  parseArgs,
  requiredEnv,
} from './lib/feishuProjectMigration.mjs';

function parseAnalysis(fields) {
  const raw = extractBitableText(fields['JSON数据']);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function listRecords(target, limit) {
  const records = [];
  let pageToken;
  do {
    const remaining = limit ? Math.max(limit - records.length, 0) : 100;
    if (limit && remaining === 0) break;
    const query = new URLSearchParams({
      page_size: String(Math.min(remaining || 100, 100)),
      automatic_fields: 'false',
    });
    if (pageToken) query.set('page_token', pageToken);
    const data = await callFeishuOpenApi(
      target,
      'GET',
      `/bitable/v1/apps/${target.baseAppToken}/tables/${target.table_id}/records?${query}`
    );
    records.push(...(data.items || []));
    pageToken = data.has_more ? data.page_token : null;
  } while (pageToken);
  return records;
}

async function persistRecord(pool, target, record, analysis) {
  const fields = record.fields || {};
  const meetingId = extractBitableText(fields['会议ID']);
  if (!meetingId) throw new Error('Base 记录缺少会议ID。');

  const topic = extractBitableText(fields['会议名称']);
  const summary = extractBitableText(fields['分析摘要']) || analysis.summary || null;
  const errorMessage = extractBitableText(fields['错误信息']);
  const result = await pool.query(
    `
      insert into public.meeting_records (
        user_id,
        integration_id,
        project_id,
        org_target_id,
        base_record_id,
        feishu_meeting_id,
        status,
        topic,
        analysis_result,
        analysis_schema_version,
        analysis_summary,
        analyzed_at,
        completed_at,
        last_error_message,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, 'completed', $7, $8::jsonb, 1, $9, now(), now(), $10, now())
      on conflict (integration_id, feishu_meeting_id)
      do update set
        project_id = excluded.project_id,
        org_target_id = excluded.org_target_id,
        base_record_id = excluded.base_record_id,
        topic = coalesce(excluded.topic, public.meeting_records.topic),
        analysis_result = excluded.analysis_result,
        analysis_schema_version = excluded.analysis_schema_version,
        analysis_summary = excluded.analysis_summary,
        analyzed_at = coalesce(public.meeting_records.analyzed_at, now()),
        completed_at = coalesce(public.meeting_records.completed_at, now()),
        last_error_message = coalesce(public.meeting_records.last_error_message, excluded.last_error_message),
        updated_at = now()
      returning id, report_public_id
    `,
    [
      target.user_id,
      target.integration_id,
      target.project_id,
      target.org_target_id,
      record.record_id,
      meetingId,
      topic,
      JSON.stringify(analysis),
      summary,
      errorMessage,
    ]
  );

  const persisted = result.rows[0];
  const reportUrl = new URL(
    `/report/${persisted.report_public_id}`,
    requiredEnv('PROJECT_PUBLIC_URL')
  ).toString();
  await pool.query(
    `update public.meeting_records set report_url = $2, updated_at = now() where id = $1`,
    [persisted.id, reportUrl]
  );
  await callFeishuOpenApi(
    target,
    'PUT',
    `/bitable/v1/apps/${target.baseAppToken}/tables/${target.table_id}/records/${record.record_id}`,
    {
      fields: {
        '报告链接': {
          text: topic ? `${topic} 会议报告` : '会议动力分析报告',
          link: reportUrl,
        },
      },
    }
  );
  return { reportPublicId: persisted.report_public_id, meetingId };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pool = createPool();
  const totals = { scanned: 0, eligible: 0, succeeded: 0, skipped: 0, failed: 0 };

  try {
    const targets = await listMigrationTargets(pool, options);
    for (const target of targets) {
      const records = await listRecords(target, options.limit);
      for (const record of records) {
        totals.scanned += 1;
        const analysis = parseAnalysis(record.fields || {});
        if (!analysis) {
          totals.skipped += 1;
          continue;
        }
        totals.eligible += 1;
        if (!options.apply) continue;

        try {
          const persisted = await persistRecord(pool, target, record, analysis);
          totals.succeeded += 1;
          logMigration('meeting_report_backfill', 'info', 'meeting_report_backfill_record_succeeded', {
            projectKey: target.project_key,
            orgKey: target.org_key,
            recordId: record.record_id,
            meetingId: persisted.meetingId,
            reportPublicId: persisted.reportPublicId,
          });
        } catch (error) {
          totals.failed += 1;
          logMigration('meeting_report_backfill', 'error', 'meeting_report_backfill_record_failed', {
            projectKey: target.project_key,
            orgKey: target.org_key,
            recordId: record.record_id,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  } finally {
    await pool.end();
  }

  logMigration(
    'meeting_report_backfill',
    totals.failed ? 'warn' : 'info',
    'meeting_report_backfill_completed',
    { ...totals, dryRun: !options.apply }
  );
  if (totals.failed) process.exitCode = 1;
}

main().catch((error) => {
  logMigration('meeting_report_backfill', 'error', 'meeting_report_backfill_unhandled_failed', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
    errorMessage: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
