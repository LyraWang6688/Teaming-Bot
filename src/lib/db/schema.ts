import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
    webhookVerificationTokenEncrypted: text('webhook_verification_token_encrypted').notNull(),
    webhookVerificationTokenHash: text('webhook_verification_token_hash').notNull(),
    baseAppTokenEncrypted: text('base_app_token_encrypted'),
    meetingTableId: text('meeting_table_id'),
    oauthScope: text('oauth_scope').notNull(),
    requiredEvents: jsonb('required_events')
      .$type<string[]>()
      .notNull()
      .default(['vc.meeting.participant_meeting_ended_v1']),
    requiredPermissions: jsonb('required_permissions')
      .$type<string[]>()
      .notNull()
      .default([
        'vc:meeting.meetingevent:read',
        'vc:record:readonly',
        'minutes:minutes.transcript:export',
        'bitable:app:read',
        'bitable:table:read',
        'bitable:record:read',
        'bitable:record:write',
      ]),
    initializedAt: timestamp('initialized_at', { withTimezone: true }),
    lastWebhookReceivedAt: timestamp('last_webhook_received_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('feishu_integrations_user_id_idx').on(table.userId),
    uniqueIndex('feishu_integrations_webhook_token_hash_uidx').on(
      table.webhookVerificationTokenHash
    ),
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
    webhookStatus: text('webhook_status').notNull().default('pending'),
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
    index('meeting_records_status_idx').on(table.status),
  ]
);

export type FeishuIntegrationRow = typeof feishuIntegrations.$inferSelect;
export type FeishuAuthorizationRow = typeof feishuAuthorizations.$inferSelect;
export type FeishuIntegrationCheckRow = typeof feishuIntegrationChecks.$inferSelect;
export type FeishuOauthStateRow = typeof feishuOauthStates.$inferSelect;
export type FeishuAuditLogRow = typeof feishuAuditLogs.$inferSelect;
export type MeetingRecordRow = typeof meetingRecords.$inferSelect;
