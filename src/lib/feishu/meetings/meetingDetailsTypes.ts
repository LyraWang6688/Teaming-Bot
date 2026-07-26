export const MEETING_DETAIL_STATUS = {
  calling: 'calling',
  ongoing: 'ongoing',
  ended: 'ended',
  unknown: 'unknown',
} as const;

export type MeetingDetailStatus =
  (typeof MEETING_DETAIL_STATUS)[keyof typeof MEETING_DETAIL_STATUS];

export type MeetingDetails = {
  meetingId: string;
  topic: string | null;
  meetingUrl: string | null;
  status: MeetingDetailStatus;
  createdAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  hostOpenId: string | null;
  hostName: string | null;
  noteId: string | null;
};

export type MeetingDetailsErrorCode =
  | 'meeting_not_found'
  | 'meeting_access_denied'
  | 'meeting_response_invalid';

export class MeetingDetailsError extends Error {
  constructor(
    public readonly code: MeetingDetailsErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'MeetingDetailsError';
  }
}
