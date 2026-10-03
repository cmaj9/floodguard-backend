-- =============================================================
-- Migration: Add is_credentials_set column to users table
-- =============================================================

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS is_credentials_set BOOLEAN NOT NULL DEFAULT FALSE;

-- Mark any existing non-synthetic users (who already have legitimate non-local emails) as credentials set
UPDATE users 
SET is_credentials_set = TRUE 
WHERE email NOT LIKE '%@waterwatch.local' 
  AND email NOT LIKE '%@floodguard.local';
