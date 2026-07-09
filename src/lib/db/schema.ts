import {
  boolean,
  integer,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnalysisResult } from '@/types';

export const feishuIntegrations = pgTable(
  'feishu_integrations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('draft'),
    setupStep: text('setup_step').notNull().default('app'),
    appId: text('app_id').notNull(),
    appSecretEncrypted: text('app_secret_encrypted').notNull(),
    baseAppTokenEncrypted: text('base_app_token_encrypted'),
    meetingTableId: text('meeting_table_id'),
    selectedOrgTargetId: uuid('selected_org_target_id'),
    orgSelectedAt: timestamp('org_selected_at', { withTimezone: true }),
    profileName: text('profile_name'),
    cliConfigDir: text('cli_config_dir'),
    oauthScope: text('oauth_scope').notNull(),
    requiredEvents: jsonb('required_events')
      .$type<string[]>()
      .notNull()
      .default(['minutes.minute.generated_v1']),
    requiredPermissions: jsonb('required_permissions')
      .$type<string[]>()
      .notNull()
      .default([
        'minutes:minutes.basic:read',
        'minutes:minutes.transcript:export',
        'offline_access',
        'bitable:app',
      ]),
    initializedAt: timestamp('initialized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('feishu_integrations_user_id_idx').on(table.userId),
    index('feishu_integrations_selected_org_target_id_idx').on(table.selectedOrgTargetId),
  ]
);

export const feishuProjects = pgTable(
  'feishu_projects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectKey: text('project_key').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('feishu_projects_project_key_uidx').on(table.projectKey),
    index('feishu_projects_status_idx').on(table.status),
  ]
);

export const feishuProjectOrgTargets = pgTable(
  'feishu_project_org_targets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').notNull(),
    orgKey: text('org_key').notNull(),
    orgName: text('org_name').notNull(),
    baseAppTokenEncrypted: text('base_app_token_encrypted').notNull(),
    tableId: text('table_id').notNull(),
    baseUrl: text('base_url').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    fieldCheckStatus: text('field_check_status').notNull().default('pending'),
    fieldCheckDetails: jsonb('field_check_details')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('feishu_project_org_targets_project_org_key_uidx').on(
      table.projectId,
      table.orgKey
    ),
    index('feishu_project_org_targets_project_id_idx').on(table.projectId),
    index('feishu_project_org_targets_enabled_idx').on(table.enabled),
  ]
);

export const feishuAuthorizations = pgTable(
  'feishu_authorizations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    integrationId: uuid('integration_id').notNull(),
    status: text('status').notNull().default('authorized'),
    authorizedOpenId: text('authorized_open_id'),
    authorizedUserName: text('authorized_user_name'),
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }).notNull(),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('feishu_authorizations_integration_id_uidx').on(table.integrationId),
  ]
);

export const feishuIntegrationChecks = pgTable(
  'feishu_integration_checks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    integrationId: uuid('integration_id').notNull(),
    appCredentialStatus: text('app_credential_status').notNull().default('pending'),
    permissionStatus: text('permission_status').notNull().default('pending'),
    eventSubscriptionStatus: text('event_subscription_status').notNull().default('pending'),
    oauthStatus: text('oauth_status').notNull().default('pending'),
    baseStatus: text('base_status').notNull().default('pending'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastErrorType: text('last_error_type'),
    lastErrorMessage: text('last_error_message'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('feishu_integration_checks_integration_id_uidx').on(table.integrationId),
  ]
);

export const feishuOauthStates = pgTable(
  'feishu_oauth_states',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull(),
    integrationId: uuid('integration_id').notNull(),
    stateHash: text('state_hash').notNull(),
    status: text('status').notNull().default('pending'),
    redirectTo: text('redirect_to'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('feishu_oauth_states_state_hash_uidx').on(table.stateHash),
    index('feishu_oauth_states_integration_id_idx').on(table.integrationId),
  ]
);

export const feishuAuditLogs = pgTable(
  'feishu_audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id'),
    integrationId: uuid('integration_id'),
    action: text('action').notNull(),
    result: text('result').notNull(),
    summary: text('summary').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('feishu_audit_logs_user_id_idx').on(table.userId),
    index('feishu_audit_logs_integration_id_idx').on(table.integrationId),
  ]
);

export const meetingRecords = pgTable(
  'meeting_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull(),
    integrationId: uuid('integration_id').notNull(),
    projectId: uuid('project_id'),
    orgTargetId: uuid('org_target_id'),
    baseRecordId: text('base_record_id'),
    feishuMeetingId: text('feishu_meeting_id').notNull(),
    minuteToken: text('minute_token'),
    status: text('status').notNull().default('meeting_ended'),
    topic: text('topic'),
    organizerOpenId: text('organizer_open_id'),
    reportUrl: text('report_url'),
    transcriptStoredAt: timestamp('transcript_stored_at', { withTimezone: true }),
    analyzedAt: timestamp('analyzed_at', { withTimezone: true }),
    lastErrorType: text('last_error_type'),
    lastErrorMessage: text('last_error_message'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('meeting_records_integration_meeting_uidx').on(
      table.integrationId,
      table.feishuMeetingId
    ),
    index('meeting_records_user_id_idx').on(table.userId),
    index('meeting_records_project_id_idx').on(table.projectId),
    index('meeting_records_org_target_id_idx').on(table.orgTargetId),
    index('meeting_records_status_idx').on(table.status),
  ]
);

export const meetingPipelineTasks = pgTable(
  'meeting_pipeline_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull(),
    integrationId: uuid('integration_id').notNull(),
    feishuMeetingId: text('feishu_meeting_id').notNull(),
    eventId: text('event_id'),
    eventType: text('event_type'),
    currentStage: text('current_stage').notNull().default('meeting_ended'),
    status: text('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    baseRecordId: text('base_record_id'),
    minuteToken: text('minute_token'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastErrorType: text('last_error_type'),
    lastErrorMessage: text('last_error_message'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('meeting_pipeline_tasks_integration_meeting_uidx').on(
      table.integrationId,
      table.feishuMeetingId
    ),
    uniqueIndex('meeting_pipeline_tasks_integration_event_uidx').on(
      table.integrationId,
      table.eventId
    ),
    index('meeting_pipeline_tasks_status_next_run_idx').on(table.status, table.nextRunAt),
    index('meeting_pipeline_tasks_integration_id_idx').on(table.integrationId),
    index('meeting_pipeline_tasks_event_id_idx').on(table.eventId),
  ]
);

export const webAnalysisTasks = pgTable(
  'web_analysis_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    status: text('status').notNull().default('pending'),
    fileName: text('file_name').notNull(),
    meetingText: text('meeting_text').notNull(),
    result: jsonb('result').$type<AnalysisResult>(),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastErrorType: text('last_error_type'),
    lastErrorMessage: text('last_error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('web_analysis_tasks_status_idx').on(table.status),
    index('web_analysis_tasks_expires_at_idx').on(table.expiresAt),
    index('web_analysis_tasks_created_at_idx').on(table.createdAt),
  ]
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    feishuOpenId: text('feishu_open_id').notNull(),
    feishuUnionId: text('feishu_union_id'),
    feishuName: text('feishu_name').notNull(),
    feishuEmail: text('feishu_email'),
    feishuAvatarUrl: text('feishu_avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('users_feishu_open_id_uidx').on(table.feishuOpenId),
  ]
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull(),
    sessionToken: text('session_token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).defaultNow().notNull(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
  },
  (table) => [
    uniqueIndex('sessions_session_token_uidx').on(table.sessionToken),
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ]
);

export type FeishuIntegrationRow = typeof feishuIntegrations.$inferSelect;
export type FeishuProjectRow = typeof feishuProjects.$inferSelect;
export type FeishuProjectOrgTargetRow = typeof feishuProjectOrgTargets.$inferSelect;
export type FeishuAuthorizationRow = typeof feishuAuthorizations.$inferSelect;
export type FeishuIntegrationCheckRow = typeof feishuIntegrationChecks.$inferSelect;
export type FeishuOauthStateRow = typeof feishuOauthStates.$inferSelect;
export type FeishuAuditLogRow = typeof feishuAuditLogs.$inferSelect;
export type MeetingRecordRow = typeof meetingRecords.$inferSelect;
export type MeetingPipelineTaskRow = typeof meetingPipelineTasks.$inferSelect;
export type WebAnalysisTaskRow = typeof webAnalysisTasks.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
