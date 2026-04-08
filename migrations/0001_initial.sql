CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL DEFAULT 'PETER',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  subscription_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  device_id TEXT NOT NULL,
  type TEXT NOT NULL,
  sent_on TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (device_id, type, sent_on),
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deliveries_device_day
  ON deliveries (device_id, sent_on);
