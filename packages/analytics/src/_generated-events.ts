// AUTO-GENERATED — do not edit. Run `node scripts/codegen-schemas.mjs` to regenerate.
// Source: schemas/analytics-events.json (46 events)

export type ApprovedEvent =
  | "user_signed_up"
  | "user_signed_in"
  | "user_signed_out"
  | "user_password_reset_requested"
  | "user_password_reset_completed"
  | "user_email_verified"
  | "trial_started"
  | "trial_converted"
  | "trial_expired"
  | "subscription_created"
  | "subscription_updated"
  | "subscription_canceled"
  | "payment_succeeded"
  | "payment_failed"
  | "checkout_started"
  | "checkout_completed"
  | "onboarding_started"
  | "onboarding_step_completed"
  | "onboarding_completed"
  | "invite_sent"
  | "invite_accepted"
  | "file_uploaded"
  | "file_downloaded"
  | "export_generated"
  | "lead_magnet_submitted"
  | "lead_magnet_delivered"
  | "page_viewed"
  | "feature_flag_evaluated"
  | "audit_record_created"
  | "report_generated"
  | "document_extracted"
  | "extraction_job_started"
  | "extraction_job_failed"
  | "grant_application_created"
  | "grant_application_submitted"
  | "vpn_session_started"
  | "vpn_session_ended"
  | "property_inspection_created"
  | "lease_parsed"
  | "support_ticket_opened"
  | "feedback_submitted"
  | "error_boundary_triggered"
  | "api_error_occurred"
  | "workspace_created"
  | "member_added"
  | "member_removed";

export const APPROVED_EVENTS = {
  user_signed_up: "user_signed_up" as const,
  user_signed_in: "user_signed_in" as const,
  user_signed_out: "user_signed_out" as const,
  user_password_reset_requested: "user_password_reset_requested" as const,
  user_password_reset_completed: "user_password_reset_completed" as const,
  user_email_verified: "user_email_verified" as const,
  trial_started: "trial_started" as const,
  trial_converted: "trial_converted" as const,
  trial_expired: "trial_expired" as const,
  subscription_created: "subscription_created" as const,
  subscription_updated: "subscription_updated" as const,
  subscription_canceled: "subscription_canceled" as const,
  payment_succeeded: "payment_succeeded" as const,
  payment_failed: "payment_failed" as const,
  checkout_started: "checkout_started" as const,
  checkout_completed: "checkout_completed" as const,
  onboarding_started: "onboarding_started" as const,
  onboarding_step_completed: "onboarding_step_completed" as const,
  onboarding_completed: "onboarding_completed" as const,
  invite_sent: "invite_sent" as const,
  invite_accepted: "invite_accepted" as const,
  file_uploaded: "file_uploaded" as const,
  file_downloaded: "file_downloaded" as const,
  export_generated: "export_generated" as const,
  lead_magnet_submitted: "lead_magnet_submitted" as const,
  lead_magnet_delivered: "lead_magnet_delivered" as const,
  page_viewed: "page_viewed" as const,
  feature_flag_evaluated: "feature_flag_evaluated" as const,
  audit_record_created: "audit_record_created" as const,
  report_generated: "report_generated" as const,
  document_extracted: "document_extracted" as const,
  extraction_job_started: "extraction_job_started" as const,
  extraction_job_failed: "extraction_job_failed" as const,
  grant_application_created: "grant_application_created" as const,
  grant_application_submitted: "grant_application_submitted" as const,
  vpn_session_started: "vpn_session_started" as const,
  vpn_session_ended: "vpn_session_ended" as const,
  property_inspection_created: "property_inspection_created" as const,
  lease_parsed: "lease_parsed" as const,
  support_ticket_opened: "support_ticket_opened" as const,
  feedback_submitted: "feedback_submitted" as const,
  error_boundary_triggered: "error_boundary_triggered" as const,
  api_error_occurred: "api_error_occurred" as const,
  workspace_created: "workspace_created" as const,
  member_added: "member_added" as const,
  member_removed: "member_removed" as const,
} satisfies Record<ApprovedEvent, ApprovedEvent>;

export type VentoraProduct =
  | "camaudit"
  | "camaudit-v2"
  | "grantpipe"
  | "lextract"
  | "floriva"
  | "streamvpn";
