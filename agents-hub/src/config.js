// Tunables shared by the Worker and the generated documentation.

export const VERSION = "1.0.0";

export const LIMITS = {
  heartbeat_interval_s: 30,
  stale_after_s: 90,
  offline_after_s: 300,
  lease_default_s: 300,
  lease_min_s: 30,
  lease_max_s: 3600,
  requests_per_minute_per_agent: 300,
  registrations_per_hour_per_ip: 120,
  max_agents: 200,
  max_body_bytes: 65536,
  max_message_chars: 8000,
  max_json_field_bytes: 16384,
  max_artifacts: 20,
  max_open_tasks: 10000,
  events_page_max: 500,
  events_wait_max_s: 25,
  event_retention_days: 7,
  event_max_rows: 100000,
  finished_task_retention_days: 14,
  idempotency_ttl_hours: 24,
  request_log_retention_days: 7,
  request_log_max_rows: 200000,
};
