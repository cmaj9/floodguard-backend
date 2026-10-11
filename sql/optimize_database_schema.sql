-- ============================================================================
-- Migration: Database Schema Optimization & Consolidation
-- Unified Single-Source-of-Truth Data Architecture
-- ============================================================================

BEGIN;

-- 1. เพิ่มคอลัมน์ใหม่ในตาราง users สำหรับรูปโปรไฟล์ LINE และยืนยันรหัสผ่าน
ALTER TABLE users 
  ADD COLUMN IF NOT EXISTS picture_url TEXT,
  ADD COLUMN IF NOT EXISTS is_credentials_set BOOLEAN DEFAULT true;

-- 2. เพิ่มคอลัมน์ฮาร์ดแวร์ในตาราง station
ALTER TABLE station
  ADD COLUMN IF NOT EXISTS dev_eui VARCHAR(64),
  ADD COLUMN IF NOT EXISTS dev_euis TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS payload_id VARCHAR(32),
  ADD COLUMN IF NOT EXISTS model VARCHAR(100) DEFAULT 'Heltec-WiFi-LoRa-32(V3)',
  ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(50) DEFAULT 'v1.2.0',
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS manual_offline_at TIMESTAMP WITH TIME ZONE;

-- 3. เพิ่มคอลัมน์ chirpstack_id และ chirpstack_ids ในตาราง gateway
ALTER TABLE gateway
  ADD COLUMN IF NOT EXISTS chirpstack_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS chirpstack_ids TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_update TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- 4. ย้ายข้อมูลจาก mcu เข้าสู่ station (ถ้าตาราง mcu ยังมีอยู่)
DO $$ BEGIN
  UPDATE station s
  SET dev_eui = sub.primary_eui,
      dev_euis = sub.all_euis,
      model = COALESCE(sub.first_model, s.model),
      firmware_version = COALESCE(sub.first_fw, s.firmware_version)
  FROM (
    SELECT 
      station_id,
      MIN(mcu_id) AS primary_eui,
      ARRAY_AGG(DISTINCT mcu_id) AS all_euis,
      MAX(model) AS first_model,
      MAX(firmware_version) AS first_fw
    FROM mcu
    GROUP BY station_id
  ) sub
  WHERE s.station_id = sub.station_id;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- 5. ย้ายข้อมูลจาก station_mapping เข้าสู่ station (ถ้ายังมีอยู่)
DO $$ BEGIN
  UPDATE station s
  SET payload_id = sm.payload_station_id
  FROM station_mapping sm
  WHERE s.station_id = sm.station_id;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- 6. ย้ายข้อมูลจาก gateway_mapping เข้าสู่ gateway (ถ้ายังมีอยู่)
DO $$ BEGIN
  UPDATE gateway g
  SET chirpstack_id = sub.primary_cs_id,
      chirpstack_ids = sub.all_cs_ids
  FROM (
    SELECT
      gateway_id,
      MIN(chirpstack_gateway_id) AS primary_cs_id,
      ARRAY_AGG(DISTINCT chirpstack_gateway_id) AS all_cs_ids
    FROM gateway_mapping
    GROUP BY gateway_id
  ) sub
  WHERE g.gateway_id = sub.gateway_id;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- 7. ปรับ Data Types ให้เป็น TIMESTAMPTZ และ NUMERIC(6, 3) เฉพาะคอลัมน์ที่ยังไม่ได้เป็น
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'readings' AND column_name = 'timestamp' AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE readings ALTER COLUMN timestamp TYPE TIMESTAMP WITH TIME ZONE USING timestamp AT TIME ZONE 'Asia/Bangkok';
  END IF;
  
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'readings' AND column_name = 'water_level' AND data_type != 'numeric'
  ) THEN
    ALTER TABLE readings 
      ALTER COLUMN water_level TYPE NUMERIC(6, 3) USING ROUND(water_level::numeric, 3),
      ALTER COLUMN raw_distance TYPE NUMERIC(6, 3) USING ROUND(raw_distance::numeric, 3);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'alerts' AND column_name = 'timestamp' AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE alerts ALTER COLUMN timestamp TYPE TIMESTAMP WITH TIME ZONE USING timestamp AT TIME ZONE 'Asia/Bangkok';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'created_at' AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE users 
      ALTER COLUMN created_at TYPE TIMESTAMP WITH TIME ZONE USING created_at AT TIME ZONE 'Asia/Bangkok',
      ALTER COLUMN updated_at TYPE TIMESTAMP WITH TIME ZONE USING updated_at AT TIME ZONE 'Asia/Bangkok';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'gateway' AND column_name = 'last_update' AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE gateway ALTER COLUMN last_update TYPE TIMESTAMP WITH TIME ZONE USING last_update AT TIME ZONE 'Asia/Bangkok';
  END IF;
END $$;

-- 8. เพิ่ม Foreign Key และ Indexes (ลบแถวตกค้างที่ไม่มี station ก่อนผูก FK)
DELETE FROM notification_settings WHERE station_id IS NOT NULL AND station_id NOT IN (SELECT station_id FROM station);

ALTER TABLE notification_settings
  DROP CONSTRAINT IF EXISTS fk_notification_station,
  ADD CONSTRAINT fk_notification_station 
    FOREIGN KEY (station_id) REFERENCES station(station_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_alerts_station_time ON alerts (station_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_cooldown ON alerts (station_id, alert_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_station_dev_eui ON station (dev_eui);
CREATE INDEX IF NOT EXISTS idx_station_payload_id ON station (payload_id);
CREATE INDEX IF NOT EXISTS idx_gateway_chirpstack_id ON gateway (chirpstack_id);

-- 9. ปรับปรุง Trigger Sequence สำหรับ alerts ให้เป็น 6 หลัก
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

-- 10. ปลดระวางตารางซ้ำซ้อน
DROP TABLE IF EXISTS line_subscribers CASCADE;
DROP TABLE IF EXISTS station_mapping CASCADE;
DROP TABLE IF EXISTS gateway_mapping CASCADE;
DROP TABLE IF EXISTS mcu CASCADE;

COMMIT;
