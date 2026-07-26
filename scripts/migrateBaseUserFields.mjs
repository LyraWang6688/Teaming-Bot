import process from 'node:process';
import {
  callFeishuOpenApi,
  createPool,
  listMigrationTargets,
  logMigration,
  parseArgs,
} from './lib/feishuProjectMigration.mjs';

const REQUIRED_FIELDS = [
  { fieldName: '会议名称', type: 1 },
  { fieldName: '创建人', type: 11 },
];
const INTERNAL_FIELDS = new Set(['JSON数据', '错误信息']);

async function listFields(target) {
  const fields = [];
  let pageToken;
  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (pageToken) query.set('page_token', pageToken);
    const data = await callFeishuOpenApi(
      target,
      'GET',
      `/bitable/v1/apps/${target.baseAppToken}/tables/${target.table_id}/fields?${query}`
    );
    fields.push(...(data.items || []));
    pageToken = data.has_more ? data.page_token : null;
  } while (pageToken);
  return fields;
}

async function processTarget(target, options) {
  const fields = await listFields(target);
  const byName = new Map(fields.map((field) => [field.field_name, field]));
  const missing = REQUIRED_FIELDS.filter((field) => !byName.has(field.fieldName));
  const removable = fields.filter((field) => INTERNAL_FIELDS.has(field.field_name));

  logMigration('base_field_migration', 'info', 'base_field_migration_target_planned', {
    projectKey: target.project_key,
    orgKey: target.org_key,
    orgName: target.org_name,
    tableId: target.table_id,
    dryRun: !options.apply,
    missingFields: missing.map((field) => field.fieldName),
    removableFields: removable.map((field) => field.field_name),
  });

  if (!options.apply) {
    return { created: 0, deleted: 0, plannedCreate: missing.length, plannedDelete: removable.length };
  }

  let created = 0;
  for (const field of missing) {
    await callFeishuOpenApi(
      target,
      'POST',
      `/bitable/v1/apps/${target.baseAppToken}/tables/${target.table_id}/fields`,
      {
        field_name: field.fieldName,
        type: field.type,
      }
    );
    created += 1;
  }

  let deleted = 0;
  if (options.confirmDeleteFields) {
    for (const field of removable) {
      await callFeishuOpenApi(
        target,
        'DELETE',
        `/bitable/v1/apps/${target.baseAppToken}/tables/${target.table_id}/fields/${field.field_id}`
      );
      deleted += 1;
    }
  }

  return {
    created,
    deleted,
    plannedCreate: missing.length,
    plannedDelete: removable.length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.confirmDeleteFields && !options.apply) {
    throw new Error('--confirm-delete-fields 必须和 --apply 一起使用。');
  }
  const pool = createPool();
  const totals = {
    targets: 0,
    succeeded: 0,
    failed: 0,
    created: 0,
    deleted: 0,
    plannedCreate: 0,
    plannedDelete: 0,
  };

  try {
    const targets = await listMigrationTargets(pool, options);
    for (const target of targets) {
      totals.targets += 1;
      try {
        const result = await processTarget(target, options);
        totals.succeeded += 1;
        totals.created += result.created;
        totals.deleted += result.deleted;
        totals.plannedCreate += result.plannedCreate;
        totals.plannedDelete += result.plannedDelete;
      } catch (error) {
        totals.failed += 1;
        logMigration('base_field_migration', 'error', 'base_field_migration_target_failed', {
          projectKey: target.project_key,
          orgKey: target.org_key,
          orgName: target.org_name,
          tableId: target.table_id,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await pool.end();
  }

  logMigration('base_field_migration', totals.failed ? 'warn' : 'info', 'base_field_migration_completed', {
    ...totals,
    dryRun: !options.apply,
    deleteConfirmed: options.confirmDeleteFields,
  });
  if (totals.failed) process.exitCode = 1;
}

main().catch((error) => {
  logMigration('base_field_migration', 'error', 'base_field_migration_unhandled_failed', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
    errorMessage: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
