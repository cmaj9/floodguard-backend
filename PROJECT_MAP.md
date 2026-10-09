# FloodGuard Project Architectural Map & File Navigation Index (`PROJECT_MAP.md`)

# 1. Project Overview and Tech Stack
- **Mission and Core Function**:
  FloodGuard is an IoT-driven telemetry and early warning platform designed to monitor real-time water levels across rivers, canals, reservoirs, and urban drainage networks. The system ingests sensor readings via LoRaWAN and ChirpStack, performs automated reference point calibration and multi-hazard threshold evaluations (water level, rate of rise, tilt drift, offline detection), and broadcasts early warning alerts to citizens and municipal staff through LINE Messaging API Flex Messages and an interactive web dashboard.
- **Technology Stack**:
  - **Programming Languages**: JavaScript (Node.js ES2022+ / CommonJS), TypeScript (v5.9 / 6.0), SQL (PostgreSQL PL/pgSQL).
  - **Frameworks & Runtimes**: Node.js (v18+) with Express 4.22.2 (Backend); React 19.2.7 with Vite 8.1.1 (Frontend SPA).
  - **Databases & Storage**: PostgreSQL 14+ (Railway cloud & local instance via `pg` connection pool); browser `localStorage` for client session cache.
  - **Key Libraries & Protocols**:
    - **Backend**: `mqtt` (v5.10 LoRa subscriber), `@line/bot-sdk` (v11.2 messaging transport), `node-cron` (v4.6 automated water summaries), `bcrypt` (v6.0 credentials security), `cors`, `dotenv`.
    - **Frontend**: `@tanstack/react-query` (v5.101 server-state sync), `react-router-dom` (v7.18 routing & deep links), `@line/liff` (v2.31 LINE Front-end Framework), `leaflet` & `react-leaflet` (v5.0 GIS mapping), `recharts` (v3.9 telemetry visualizations), `date-fns` (v4.4), `papaparse` (v5.5 CSV processing), `tailwindcss` (v4.3).
  - **Deployment Tools**: Railway (Backend API & PostgreSQL hosting), Vercel (Frontend static edge hosting), Git (Semantic Versioning `vX.Y.Z`).

---

# 2. Directory Tree and Module Boundaries

```
Project/
├── Project_Backend/
│   ├── .agents/                 # Engineering and release rules (git_versioning.md)
│   ├── docs/                    # Database data dictionary and engineering documentation
│   ├── public/                  # Publicly served static assets (LINE Flex message imagery)
│   ├── sql/                     # DDL schemas, migration scripts, and database triggers
│   └── src/
│       ├── config/              # Infrastructure clients (PostgreSQL connection pool, MQTT broker)
│       ├── routes/              # Express REST endpoints, webhooks, and HTTP transport handlers
│       ├── scripts/             # Database initialization, migration, and cloud synchronization tools
│       ├── services/            # Core business logic (alerts, telemetry parsing, LINE bot, RBAC)
│       ├── app.js               # Express application middleware pipeline and route configuration
│       └── server.js            # Node.js process bootstrapper, background timers, and lifecycle management
│
└── Project_FontEnd/
    ├── .agents/                 # Design standards, responsive UI architecture, and git rules
    ├── public/                  # Static web resources, icons, and audio assets
    └── src/
        ├── assets/              # Static vector illustrations and graphic resources
        ├── components/
        │   ├── charts/          # Telemetry and hydrological time-series chart components
        │   ├── dashboard/       # Dashboard telemetry hubs, KPI cards, docks, and hero banners
        │   ├── layout/          # Layout shell, TopBar, Sidebar, and mobile BottomNav
        │   ├── map/             # Leaflet GIS station map and status marker layers
        │   ├── stations/        # Station modals, calibration interfaces, and threshold configs
        │   ├── ui/              # Atomic reusable UI elements (Modals, Icons, SegmentedControl)
        │   └── users/           # User management tables, role assignment modals, and credential forms
        ├── context/             # Global React Context providers (Auth, Notifications, Toasts)
        ├── data/                # Fallback static datasets and development mock records
        ├── pages/               # Top-level view routes (Dashboard, Chart, History, Management, Auth)
        ├── services/            # Client-side API abstraction layer (Axios) and LINE LIFF runtime
        ├── types/               # Central TypeScript domain interfaces, unions, and payload contracts
        ├── utils/               # Hydrological filtering, CSV generation, and image helpers
        ├── App.tsx              # Router composition, LIFF deep-link forwarding, and RBAC guards
        ├── index.css            # Global CSS design tokens, obsidian palette, and utility classes
        └── main.tsx             # React 19 application mounting entry point
```

### Module Boundary Definitions:
- `Project_Backend/src/config/`: Manages external connection lifecycles for relational storage and IoT message brokers.
- `Project_Backend/src/routes/`: Exposes REST endpoints, validates incoming HTTP payloads, and verifies LINE HMAC signatures.
- `Project_Backend/src/services/`: Encapsulates domain logic including LoRaWAN parsing, relative water level math, alert escalations, and LINE multicast.
- `Project_Backend/sql/`: Defines declarative table definitions, constraints, triggers, and state migration scripts.
- `Project_FontEnd/src/components/`: Houses reusable and feature-scoped presentation layers adhering to responsive WCAG AA design rules.
- `Project_FontEnd/src/context/`: Coordinates shared client states including authentication session persistence, alert queues, and transient toasts.
- `Project_FontEnd/src/pages/`: Manages page-level lifecycle, query fetching, view composition, and mobile responsive guards.
- `Project_FontEnd/src/services/`: Centralizes external HTTP data retrieval and LINE LIFF SDK initialization.
- `Project_FontEnd/src/utils/`: Provides deterministic client utilities for hydrological noise reduction, formatting, and data export.

---

# 3. Core Execution Flow and Entry Points

### Primary Entry Points
- **Backend Process Entry (`Project_Backend/src/server.js`)**:
  Initializes server environment timezone (`Asia/Bangkok`), validates PostgreSQL connectivity, verifies table existence with auto-initialization fallback, connects MQTT subscriber (or switches to HTTP webhook mode), starts periodic 5-minute offline watchdog, registers morning (07:00) and evening (18:00) water summary cron tasks, binds Express to HTTP port, and attaches graceful shutdown handlers (`SIGTERM`, `SIGINT`).
- **Backend Application Pipeline (`Project_Backend/src/app.js`)**:
  Configures CORS whitelist for development and production domains, sets up JSON body parsing with raw body retention (`req.rawBody`) for LINE Webhook signature verification, serves `/public` static media, mounts API router modules, and exposes `/health` health-check endpoint.
- **Frontend Application Root (`Project_FontEnd/src/main.tsx` & `Project_FontEnd/src/App.tsx`)**:
  Mounts React root into `#root`, encapsulates the DOM tree within `QueryClientProvider`, `BrowserRouter`, `AuthProvider`, `NotificationProvider`, and `ToastProvider`, manages LIFF query param forwarding (`?liff.state=/path`), and resolves RBAC route protection (`ProtectedRoute`).

### Standard End-to-End Data Lifecycles

#### A. IoT Telemetry Ingestion & Real-Time Alert Lifecycle
1. **IoT Node Transmission**: Microcontroller transmits LoRaWAN uplink containing distance, battery, temperature, humidity, and tilt metrics.
2. **Gateway / Network Server**: ChirpStack forwards payload via MQTT topic (`application/+/device/+/event/up`) or HTTP POST to `/api/readings/webhook`.
3. **Ingress Ingestion & Parsing**: `Project_Backend/src/services/readingService.js` (`processUplinkMessage`):
   - Decodes Base64 binary protocol or JSON object.
   - Maps DevEUI to database station identifier (`mcu` -> `station`).
   - Calculates relative water level: `water_level = sensor_to_ref_distance - raw_distance`.
   - Flags sensor blind zone: `is_blind_zone = (raw_distance <= blind_zone_offset)`.
   - Persists reading to `readings` table and updates `station` / `mcu` last seen timestamps.
4. **Hazard & Alert Evaluation**: `Project_Backend/src/services/alertService.js` (`checkReadingAlerts`):
   - Evaluates warning and critical water level thresholds, rate of rise, tilt drift (>15°), and battery levels.
   - Checks alert cooldown with escalation bypass (transition to Critical level immediately overrides cooldown).
   - Records incident in `alerts` table.
   - Dispatches formatted Bento Grid Flex Messages via LINE Messaging API (`Project_Backend/src/services/lineService.js`) to subscribed citizens and assigned staff.
5. **Dashboard Presentation**: `Project_FontEnd/src/components/dashboard/StationTelemetryHub.tsx` pulls fresh telemetry via TanStack Query, executes client-side filtering (`waterLevelFilter.ts`), and renders real-time KPI cards and charts.

#### B. Client Data Mutation Lifecycle (e.g., Station Calibration)
1. **User Action**: Staff/Admin inputs updated reference distance and tilt offsets in `StationCalibrationModal.tsx`.
2. **Client API Call**: `Project_FontEnd/src/services/apiService.ts` (`updateStationCalibration`) dispatches Axios PUT request.
3. **Router Dispatch**: Handled by `Project_Backend/src/routes/stations.js` (`PUT /api/stations/:stationId/calibration`).
4. **Service & Database Execution**: Updates calibration parameters in `station` table and calls `recalculateStationReadings` in `readingService.js` to re-index historical relative levels.
5. **Cache Invalidation & Re-render**: Frontend TanStack Query invalidates `['stations']` and `['readings']` query keys, refreshing UI state seamlessly.

#### C. LINE LIFF Citizen Onboarding Lifecycle
1. **User Follow / QR Scan**: Citizen adds LINE Official Account or opens LIFF URL.
2. **Webhook Receipt**: `Project_Backend/src/routes/lineWebhook.js` verifies HMAC-SHA256 signature and captures `follow` event.
3. **Account Creation**: `Project_Backend/src/services/userService.js` registers citizen in `users` and `line_subscribers`.
4. **LIFF Handshake**: User opens LIFF web link -> `Project_FontEnd/src/services/liffService.ts` initializes LIFF SDK -> `AuthContext.tsx` retrieves profile and initializes guest/citizen session without credential barriers.

---

# 4. Feature-to-File Mapping

| Domain / Feature | UI / Entry File | Logic / Controller / Hook | Service / API / Model |
| :--- | :--- | :--- | :--- |
| **Authentication & RBAC** | `Project_FontEnd/src/pages/LoginPage.tsx`<br>`Project_FontEnd/src/pages/CitizenRegisterPage.tsx`<br>`Project_FontEnd/src/pages/SetupCredentialsPage.tsx` | `Project_FontEnd/src/context/AuthContext.tsx`<br>`Project_Backend/src/routes/users.js` | `Project_FontEnd/src/services/apiService.ts`<br>`Project_Backend/src/services/userService.js`<br>`Project_Backend/sql/add_users.sql` |
| **Telemetry Ingestion (IoT)** | `Project_Backend/src/config/mqtt.js` (MQTT)<br>`Project_Backend/src/routes/readings.js` (Webhook) | `Project_Backend/src/services/readingService.js` | `Project_Backend/sql/init.sql` (`readings`, `mcu`) |
| **Station Dashboard & Hub** | `Project_FontEnd/src/pages/DashboardPage.tsx`<br>`Project_FontEnd/src/components/dashboard/StationTelemetryHub.tsx` | `Project_FontEnd/src/components/dashboard/FloatingActionDock.tsx`<br>`Project_FontEnd/src/components/dashboard/StationSegmentedControl.tsx` | `Project_FontEnd/src/services/apiService.ts` (`fetchLatestReadings`, `fetchStations`) |
| **Hydrological Analytics & Charts**| `Project_FontEnd/src/pages/ChartPage.tsx`<br>`Project_FontEnd/src/components/charts/WaterLevelChart.tsx` | `Project_FontEnd/src/utils/waterLevelFilter.ts`<br>`Project_Backend/src/routes/readings.js` (`/:stationId/range`) | `Project_Backend/src/services/readingService.js` (`getReadingsInRange`) |
| **Telemetry History & Auditing** | `Project_FontEnd/src/pages/DataHistoryPage.tsx` | `Project_FontEnd/src/components/dashboard/MetricKpiCard.tsx`<br>`Project_FontEnd/src/components/ui/CompactFilterDropdown.tsx` | `Project_Backend/src/routes/readings.js` (`/history`) |
| **Station Management & Calibration** | `Project_FontEnd/src/pages/StationsPage.tsx`<br>`Project_FontEnd/src/components/stations/StationModal.tsx` | `Project_FontEnd/src/components/stations/StationCalibrationModal.tsx`<br>`Project_Backend/src/routes/stations.js` | `Project_Backend/src/services/readingService.js` (`recalculateStationReadings`)<br>`Project_Backend/sql/migrate_relative_level.sql` |
| **GIS Mapping** | `Project_FontEnd/src/components/map/StationMap.tsx` | Leaflet map layer with custom status SVG markers | `Project_FontEnd/src/services/apiService.ts` (`fetchStations`) |
| **Alerts & Hazard Monitoring** | `Project_FontEnd/src/components/ui/NotificationPanel.tsx` | `Project_FontEnd/src/context/NotificationContext.tsx`<br>`Project_Backend/src/routes/alerts.js` | `Project_Backend/src/services/alertService.js`<br>`Project_Backend/sql/init.sql` (`alerts`) |
| **Notification Criteria Settings** | `Project_FontEnd/src/components/stations/StationNotificationModal.tsx` | `Project_Backend/src/routes/notificationSettings.js` | `Project_Backend/src/services/notificationSettingService.js` |
| **LINE Official Account & Webhook**| `Project_Backend/src/routes/lineWebhook.js` | `Project_Backend/src/services/lineService.js` (`replyMessage`, `sendLineAlert`) | `@line/bot-sdk`<br>`Project_Backend/sql/add_line_subscribers.sql` |
| **LINE LIFF Public Subscription**| `Project_FontEnd/src/pages/SubscribePage.tsx` | `Project_FontEnd/src/services/liffService.ts`<br>`Project_Backend/src/routes/notificationSettings.js` | `Project_FontEnd/src/services/apiService.ts` (`saveSubscriberPreferences`) |
| **Automated Scheduled Broadcasts** | `Project_Backend/src/server.js` (`initScheduler`) | `Project_Backend/src/services/schedulerService.js` | `node-cron`<br>`Project_Backend/src/services/lineService.js` (`createStatusSummaryFlexMessage`) |
| **CSV Data Export** | `Project_FontEnd/src/utils/exportCSV.ts` (Client)<br>`Project_Backend/src/routes/readings.js` (`/export/csv`) | `Project_Backend/src/services/readingService.js` (`exportReadingsToCSV`) | Streaming UTF-8 BOM CSV via HTTP / Blob download |
| **User Management (Admin)** | `Project_FontEnd/src/pages/UsersPage.tsx`<br>`Project_FontEnd/src/components/users/UserTable.tsx` | `Project_FontEnd/src/components/users/UserModal.tsx`<br>`Project_Backend/src/routes/users.js` | `Project_Backend/src/services/userService.js` |
| **Mobile Management Hub** | `Project_FontEnd/src/pages/ManagementHubPage.tsx` | Responsive viewport guard (`window.innerWidth < 1024`) | Role-based navigation directory |
| **Database Synchronization** | `Project_Backend/src/routes/sync.js` | `Project_Backend/src/scripts/syncToRailway.js`<br>`Project_Backend/src/scripts/syncFromRailway.js` | Direct cross-database PostgreSQL dump & sync |

---

# 5. State Management and Data Schema

### Global State & Contexts
- **`Project_FontEnd/src/context/AuthContext.tsx`**:
  - Manages authenticated user state (`user: AuthUser | null`), guest state (`isGuest`), session initialization, and login/logout methods.
  - Persists state in `localStorage` under `wl_auth_user`.
  - Integrates with LIFF OAuth callback parsing to auto-bind LINE credentials.
- **`Project_FontEnd/src/context/NotificationContext.tsx`**:
  - Polls backend alerts (`GET /api/alerts`) every 30 seconds.
  - Transforms database alerts into UI notifications, computes unread badge counters, and exposes `acknowledgeAlert()`.
- **`Project_FontEnd/src/context/ToastContext.tsx`**:
  - Maintains active toast notification stack with 4-second auto-dismiss timers and theme styling (`login`, `line`, `profile`, `logout`, `email`, `info`).
- **TanStack React Query (`Project_FontEnd/src/App.tsx`)**:
  - Global server-state caching with `staleTime: 30000` and single retry policy.
  - Primary Query Keys: `['stations']`, `['readings']`, `['readings-history']`, `['alerts']`, `['notification-settings']`.

### Database Schemas & Migrations (`Project_Backend/sql/`)
- **`init.sql`**: Core table definitions:
  - `gateway`: LoRa gateways (`gateway_id`, `gateway_name`, `ip_address`, `status`, `last_update`).
  - `station`: Monitoring stations (`station_id`, `gateway_id`, `station_name`, `station_type`, `location_name`, `latitude`, `longitude`, `status`, `warning_level`, `critical_level`).
  - `mcu`: Microcontroller telemetry records (`mcu_id`, `station_id`, `model`, `firmware_version`, `signal_strength`, `battery_level`).
  - `readings`: Time-series sensor log (`reading_id`, `station_id`, `timestamp`, `raw_distance`, `water_level`, `temperature`, `humidity`, `battery_voltage`, `battery_percent`, `rssi`, `snr`, `tilt_x`, `tilt_y`, `latitude`, `longitude`).
  - `alerts`: Event log with auto-generated ID trigger (`alert_id`, `station_id`, `timestamp`, `alert_type`, `value`, `threshold`, `message`, `status`).
  - `station_mapping` & `gateway_mapping`: Payload hardware-to-database foreign key mappings.
- **`add_users.sql`**: Multi-role account store (`users` table with `UserRole` enum `'citizen' | 'staff' | 'admin'`, bcrypt password hash, assigned `station_ids` array, and `line_user_id`).
- **`add_line_subscribers.sql`**: Separate subscriber store (`line_subscribers` table) storing citizen followers and subscribed stations.
- **`add_credentials_set.sql`**: Tracks whether a citizen has upgraded their account to email/password.
- **`migrate_relative_level.sql`**: Schema alterations adding reference point distance (`sensor_to_ref_distance`), reference label (`reference_point_name`), ultrasonic blind zone (`blind_zone_offset`), and calibration tilt offsets (`tilt_offset_x`, `tilt_offset_y`).
- **Type Definitions (`Project_FontEnd/src/types/index.ts`)**:
  Defines central TypeScript interfaces matching database models (`Reading`, `StationWithReading`, `Station`, `WaterLevelReading`, `AuthUser`, `User`, `DbAlert`, `NotificationSettings`, `SubscriberPreferences`).

---

# 6. Critical Dependencies, Conventions, and Gotchas

### High-Coupling Shared Modules
- `Project_Backend/src/config/database.js`: Singleton `pg.Pool` instance supporting parameterized queries across all services.
- `Project_Backend/src/services/lineService.js`: Encapsulates LINE Messaging API calls; all broadcast operations and Flex layouts route through this module.
- `Project_FontEnd/src/services/apiService.ts`: Central Axios client configured with base URL resolution, timeout, and response unwrapping.
- `Project_FontEnd/src/utils/waterLevelFilter.ts`: Core 3-layer hydrological smoothing algorithm required by telemetry charts.
- `Project_FontEnd/src/components/ui/Icons.tsx`: Central vector SVG repository ensuring 100% Zero-Emoji design compliance.
- `Project_FontEnd/src/index.css`: Design tokens defining colors, borders, shadows, and responsive breakpoint variables.

### Architectural Conventions
- **Relative Water Level Equation**:
  ```text
  Water Level (m) = sensor_to_ref_distance - raw_distance
  ```
  All telemetry computations (readings ingestion, calibration recalculation, alerting) adhere to this relative standard where positive values indicate water above the reference point.
- **Sensor Blind Zone Constraint**:
  If `raw_distance <= blind_zone_offset` (typically 0.28m for ultrasonic sensors), `is_blind_zone` is set to `true` to flag potential sensor saturation.
- **3-Tier Role-Based Access Control (RBAC)**:
  - `citizen`: Read-only access to public dashboard, telemetry charts, and station notification subscription. Restricted from data exports and management forms.
  - `staff`: Operational access to assigned station telemetry, manual status overrides, and sensor calibration adjustments.
  - `admin`: Unrestricted administrative access including user management, system configuration, and data exports.
- **Zero-Emoji Policy**:
  Strict prohibition of Unicode emojis in LINE OA messages and UI screens; vector SVG representations or clean text badges must be used.

### Required Environment Variables

#### Backend (`Project_Backend/.env`)
- `PORT`: HTTP port for Express server (default: `3001`).
- `DATABASE_URL` (or `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`): PostgreSQL connection parameters.
- `MQTT_BROKER`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_TOPIC`: LoRaWAN broker configuration.
- `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`: LINE Messaging API credentials.
- `FRONTEND_URL`: Allowed CORS origin for production frontend.
- `ALERT_COOLDOWN_MINUTES`: Minimum duration between duplicate alert events (default: `30`).
- `TZ`: System timezone (must be `Asia/Bangkok`).

#### Frontend (`Project_FontEnd/.env`)
- `VITE_API_URL`: Backend REST API URL endpoint.
- `VITE_LIFF_ID`: LINE Front-end Framework application ID.

### Known Technical Hazards & Gotchas
1. **Raw Body Preservation for LINE Webhook**:
   `Project_Backend/src/app.js` must preserve `req.rawBody` during JSON parsing (`verify: (req, _res, buf) => { req.rawBody = buf; }`). Changing or re-ordering body parser middlewares invalidates HMAC-SHA256 signature verification and causes LINE webhooks to return `403 Forbidden`.
2. **Batch Recalculation Impact**:
   Updating `sensor_to_ref_distance` in `PUT /api/stations/:stationId/calibration` triggers `recalculateStationReadings()`, running an `UPDATE readings` batch query. On large production datasets, this operation locks rows; ensure adequate query timeout configuration.
3. **LIFF Query Parameter Stripping & Forwarding**:
   The LINE mobile client wraps deep links in `?liff.state=/path`. `LiffRedirectHandler` in `App.tsx` must parse, strip, and navigate to the clean path before the router matches, otherwise deep links redirect to the default dashboard.
4. **PostgreSQL SSL Connection Detection**:
   In `Project_Backend/src/config/database.js`, SSL mode is automatically toggled based on the presence of `railway.app` or production mode (`rejectUnauthorized: false`). Connecting to local PostgreSQL with SSL enabled will cause connection rejection.
5. **Git Commit & Release Policy**:
   Agents must never run `git commit` or `git push` autonomously. Version changes must follow 3-decimal Semantic Versioning (`vX.Y.Z`) and await explicit user instruction.
