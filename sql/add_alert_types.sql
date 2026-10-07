-- =============================================================
-- Migration: Add alert type enums for rate_of_rise and geofence
-- Run AFTER init.sql (which already created AlertType enum)
-- Command: psql -U postgres -d water_monitor -f sql/add_alert_types.sql
-- =============================================================

-- Add new alert type values (safe: DO block ignores if already exists)
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'rate_of_rise';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'geofence';

-- Add 'offline' type for when station stops sending data
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'offline';

-- Add 'online' type for when station recovers and sends data again
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'online';

SELECT 'alert types updated successfully!' AS message;
