/**
 * Emitted by ExportJobService when a background export (notifications or audit logs)
 * finishes or fails. NotificationService tells the person who requested it.
 * Carries no row data and no file keys.
 */
export interface ExportJobFinishedEvent {
  userId: string;
  jobId: string;
  scope: 'NOTIFICATIONS' | 'AUDIT_LOGS';
  status: 'COMPLETED' | 'FAILED';
  rowCount: number;
}
