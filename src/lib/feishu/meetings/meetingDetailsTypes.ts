export type MeetingDetails = {
  meetingId: string;
  topic: string | null;
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
