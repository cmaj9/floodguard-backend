-- ============================================================
-- Migration: Add Relative Water Level & Reference Point Calibration
-- ============================================================

-- 1. Add columns to station
ALTER TABLE station ADD COLUMN IF NOT EXISTS sensor_to_ref_distance FLOAT DEFAULT 2.0;
ALTER TABLE station ADD COLUMN IF NOT EXISTS reference_point_name VARCHAR(100) DEFAULT 'จุดอ้างอิง';
ALTER TABLE station ADD COLUMN IF NOT EXISTS blind_zone_offset FLOAT DEFAULT 0.28;
ALTER TABLE station ADD COLUMN IF NOT EXISTS tilt_compensation_enabled BOOLEAN DEFAULT true;
ALTER TABLE station ADD COLUMN IF NOT EXISTS tilt_offset_x NUMERIC(5, 2) DEFAULT 0.0;
ALTER TABLE station ADD COLUMN IF NOT EXISTS tilt_offset_y NUMERIC(5, 2) DEFAULT 0.0;

-- Ensure default values for existing rows
UPDATE station
SET
  sensor_to_ref_distance = COALESCE(sensor_to_ref_distance, 2.0),
  reference_point_name   = CASE
    WHEN reference_point_name IS NULL OR TRIM(reference_point_name) = '' THEN 'จุดอ้างอิง'
    ELSE reference_point_name
  END,
  blind_zone_offset      = COALESCE(blind_zone_offset, 0.28),
  tilt_compensation_enabled = COALESCE(tilt_compensation_enabled, true);

-- 2. Add columns to readings
ALTER TABLE readings ADD COLUMN IF NOT EXISTS raw_distance FLOAT;
ALTER TABLE readings ADD COLUMN IF NOT EXISTS is_blind_zone BOOLEAN DEFAULT false;

-- 3. Historical Data Recalculation:
-- In historical readings, water_level stored the raw sensor distance in meters (e.g. 1.569 m).
-- Recalculate: raw_distance = old water_level, new water_level = D_ref - D_sensor
UPDATE readings r
SET
  raw_distance = r.water_level,
  water_level = ROUND((s.sensor_to_ref_distance - r.water_level)::numeric, 3),
  is_blind_zone = (r.water_level <= COALESCE(s.blind_zone_offset, 0.28))
FROM station s
WHERE r.station_id = s.station_id
  AND r.raw_distance IS NULL
  AND r.water_level IS NOT NULL;
