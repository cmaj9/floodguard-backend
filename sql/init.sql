-- ============================================================
-- Water Level Monitoring System (FloodGuard) - Unified Database Schema
-- Run: psql -U postgres -d water_monitor -f sql/init.sql
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- ENUMS
-- ============================================================
DO $$ BEGIN
  CREATE TYPE "GatewayStatus" AS ENUM ('online', 'offline', 'maintenance');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StationType" AS ENUM ('river', 'canal', 'reservoir', 'urban');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StationStatus" AS ENUM ('active', 'inactive', 'maintenance', 'offline');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AlertType" AS ENUM (
    'water_level',
    'rate_of_rise',
    'battery',
    'battery_low',
    'offline',
    'online',
    'tilt',
    'geofence',
    'sensor_drift'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AlertStatus" AS ENUM ('active', 'acknowledged', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- 1. TABLE: gateway
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway (
  gateway_id      VARCHAR(20) PRIMARY KEY,
  gateway_name    VARCHAR(100),
  ip_address      VARCHAR(50),
  chirpstack_id   VARCHAR(64),
  chirpstack_ids  TEXT[] DEFAULT '{}',
  last_update     TIMESTAMP WITH TIME ZONE,
  status          "GatewayStatus" DEFAULT 'offline',
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- 2. TABLE: station
-- ============================================================
CREATE TABLE IF NOT EXISTS station (
  station_id                 VARCHAR(20) PRIMARY KEY,
  gateway_id                 VARCHAR(20) NOT NULL REFERENCES gateway(gateway_id) ON DELETE RESTRICT,
  station_name               VARCHAR(100) NOT NULL,
  station_type               "StationType" DEFAULT 'river',
  location_name              VARCHAR(150),
  latitude                   DECIMAL(10, 6),
  longitude                  DECIMAL(10, 6),
  install_date               DATE,
  status                     "StationStatus" DEFAULT 'active',
  status_updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  manual_offline_at          TIMESTAMP WITH TIME ZONE,
  -- Hardware & Sensor Telemetry Mapping
  dev_eui                    VARCHAR(64),
  dev_euis                   TEXT[] DEFAULT '{}',
  payload_id                 VARCHAR(32),
  model                      VARCHAR(64),
  firmware_version           VARCHAR(32),
  -- Calibration & Reference Configuration
  sensor_to_ref_distance     FLOAT DEFAULT 2.0,
  reference_point_name       VARCHAR(100) DEFAULT 'จุดอ้างอิง',
  blind_zone_offset          FLOAT DEFAULT 0.28,
  tilt_compensation_enabled  BOOLEAN DEFAULT true,
  tilt_offset_x              FLOAT DEFAULT 0.0,
  tilt_offset_y              FLOAT DEFAULT 0.0,
  -- Thresholds (relative to reference point)
  warning_level              FLOAT,
  critical_level             FLOAT,
  max_level                  FLOAT,
  normal_max                 FLOAT
);

CREATE INDEX IF NOT EXISTS idx_station_gateway ON station(gateway_id);
CREATE INDEX IF NOT EXISTS idx_station_dev_eui ON station(dev_eui);
CREATE INDEX IF NOT EXISTS idx_station_payload_id ON station(payload_id);

-- ============================================================
-- 3. TABLE: users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  user_id            SERIAL PRIMARY KEY,
  name               VARCHAR(100) NOT NULL,
  email              VARCHAR(150) UNIQUE NOT NULL,
  password_hash      VARCHAR(255) NOT NULL,
  phone              VARCHAR(20) DEFAULT '',
  role               VARCHAR(20) NOT NULL DEFAULT 'citizen',
  district           VARCHAR(100) DEFAULT '',
  line_user_id       VARCHAR(64) UNIQUE,
  station_ids        TEXT[] DEFAULT '{}',
  picture_url        TEXT,
  is_active          BOOLEAN DEFAULT true,
  is_credentials_set BOOLEAN DEFAULT true,
  created_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_line_user_id ON users(line_user_id) WHERE line_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ============================================================
-- 4. TABLE: notification_settings
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_settings (
  setting_id               SERIAL PRIMARY KEY,
  station_id               VARCHAR(50) UNIQUE REFERENCES station(station_id) ON DELETE CASCADE,
  water_level_enabled      BOOLEAN DEFAULT true,
  safety_offset            FLOAT DEFAULT 0.0,
  rate_of_rise_enabled     BOOLEAN DEFAULT true,
  rate_of_rise_threshold   FLOAT DEFAULT 0.30,
  offline_timeout_enabled  BOOLEAN DEFAULT true,
  offline_timeout_minutes  INTEGER DEFAULT 30,
  battery_low_enabled      BOOLEAN DEFAULT true,
  battery_low_threshold    FLOAT DEFAULT 20.0,
  geofence_enabled         BOOLEAN DEFAULT true,
  geofence_radius_meters   FLOAT DEFAULT 100.0,
  created_at               TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at               TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- 5. TABLE: readings
-- ============================================================
CREATE TABLE IF NOT EXISTS readings (
  reading_id      BIGSERIAL PRIMARY KEY,
  station_id      VARCHAR(20) NOT NULL REFERENCES station(station_id) ON DELETE CASCADE,
  timestamp       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  raw_distance    NUMERIC(6, 3),
  water_level     NUMERIC(6, 3),
  is_blind_zone   BOOLEAN DEFAULT false,
  temperature     FLOAT,
  humidity        FLOAT,
  battery_voltage FLOAT,
  battery_percent FLOAT,
  rssi            FLOAT,
  snr             FLOAT,
  tilt_x          FLOAT,
  tilt_y          FLOAT,
  latitude        DECIMAL(10, 6),
  longitude       DECIMAL(10, 6)
);

CREATE INDEX IF NOT EXISTS idx_readings_station_time ON readings (station_id, timestamp DESC);

-- ============================================================
-- 6. TABLE: alerts
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS alert_id_seq START 1;

CREATE OR REPLACE FUNCTION generate_alert_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.alert_id IS NULL OR NEW.alert_id = '' THEN
    NEW.alert_id := 'AL-' || LPAD(nextval('alert_id_seq')::TEXT, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS alerts (
  alert_id   VARCHAR(20) PRIMARY KEY,
  station_id VARCHAR(20) NOT NULL REFERENCES station(station_id) ON DELETE CASCADE,
  timestamp  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  alert_type "AlertType",
  value      FLOAT,
  threshold  FLOAT,
  message    VARCHAR(255),
  status     "AlertStatus" DEFAULT 'active'
);

DROP TRIGGER IF EXISTS trg_alert_id ON alerts;
CREATE TRIGGER trg_alert_id
  BEFORE INSERT ON alerts
  FOR EACH ROW EXECUTE FUNCTION generate_alert_id();

CREATE INDEX IF NOT EXISTS idx_alerts_station_type_time ON alerts (station_id, alert_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status);

-- ============================================================
-- DEFAULT SEED DATA
-- ============================================================
INSERT INTO gateway (gateway_id, gateway_name, ip_address, chirpstack_id, chirpstack_ids, status, last_update) VALUES
  ('GW-001', 'Gateway_01', '192.168.1.100', '0016c001f1225893', ARRAY['0016c001f1225893', 'aa555a0000000000'], 'online', NOW())
ON CONFLICT (gateway_id) DO UPDATE SET
  chirpstack_id = COALESCE(gateway.chirpstack_id, EXCLUDED.chirpstack_id),
  chirpstack_ids = CASE WHEN cardinality(gateway.chirpstack_ids) > 0 THEN gateway.chirpstack_ids ELSE EXCLUDED.chirpstack_ids END;

INSERT INTO station (
  station_id, gateway_id, station_name, station_type,
  location_name, latitude, longitude, install_date, status,
  dev_eui, dev_euis, payload_id, model, firmware_version,
  sensor_to_ref_distance, reference_point_name,
  warning_level, critical_level, max_level, normal_max
) VALUES
  ('ST-001', 'GW-001', 'มหาวิทยาลัยราชมงคลธัญบุรี', 'river',
   'อ.คลองหก จ.ปทุมธานี', 14.03593, 100.72516, '2024-01-15', 'active',
   '65bcbb52145372b1', ARRAY['65bcbb52145372b1', 'a1b2c3d4e5f60001'], '1', 'Heltec-WiFi-LoRa-32(V3)', 'v1.2.0',
   2.0, 'ขอบตลิ่ง', -0.5, 0.0, 1.0, -1.0),
  ('ST-002', 'GW-001', 'สถานีคลองรังสิต', 'canal',
   'อ.ธัญบุรี จ.ปทุมธานี', 14.0208, 100.7594, '2024-02-10', 'active',
   'a1b2c3d4e5f60002', ARRAY['a1b2c3d4e5f60002'], '2', 'Heltec-WiFi-LoRa-32(V3)', 'v1.2.0',
   2.5, 'ขอบตลิ่ง', -0.6, 0.0, 1.0, -1.2)
ON CONFLICT (station_id) DO NOTHING;

-- Global default notification settings (station_id = NULL)
INSERT INTO notification_settings (
  station_id, water_level_enabled, safety_offset, rate_of_rise_enabled,
  rate_of_rise_threshold, offline_timeout_enabled, offline_timeout_minutes,
  battery_low_enabled, battery_low_threshold, geofence_enabled, geofence_radius_meters
) VALUES (
  NULL, true, 0.0, true, 0.30, true, 30, true, 20.0, true, 100.0
) ON CONFLICT DO NOTHING;
