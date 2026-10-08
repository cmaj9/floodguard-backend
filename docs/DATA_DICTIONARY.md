# Data Dictionary (พจนานุกรมข้อมูลระบบ FloodGuard)

ระบบฐานข้อมูล PostgreSQL สำหรับโครงการตรวจวัดระดับน้ำและแจ้งเตือนภัยน้ำท่วมอัจฉริยะ (**FloodGuard Telemetry & Early Warning System**)

---

## 1. ภาพรวมโครงสร้างฐานข้อมูล (Database Overview)

ฐานข้อมูลของระบบประกอบด้วยตารางข้อมูลหลักที่ทำงานร่วมกัน ได้แก่:
1. **`gateway`**: จัดเก็บข้อมูลสถานีแม่ข่ายรับส่งสัญญาณ (LoRa Gateway)
2. **`station`**: จัดเก็บข้อมูลสถานีตรวจวัดระดับน้ำ พิกัดภูมิศาสตร์ การสอบเทียบจุดอ้างอิง และเกณฑ์ระดับน้ำ
3. **`mcu`**: จัดเก็บข้อมูลบอร์ดไมโครคอนโทรลเลอร์ที่ประจำการในแต่ละสถานี สเปก และสถานะฮาร์ดแวร์
4. **`sensors`**: จัดเก็บรายละเอียดประเภทเซนเซอร์ตรวจวัด (Ultrasonic, Pressure) ช่วงการวัด และสถานะเซนเซอร์ (ตารางอ้างอิงสเปกฮาร์ดแวร์)
5. **`readings`**: จัดเก็บประวัติข้อมูลการตรวจวัดโทรมาตร (Telemetry) ทั้งระดับน้ำ สภาพแวดล้อม แบตเตอรี่ สัญญาณวิทยุ และพิกัดทุ่น
6. **`alerts`**: จัดเก็บประวัติเหตุการณ์แจ้งเตือนภัยและสถานะการจัดการเหตุฉุกเฉิน
7. **`station_mapping`**: จับคู่หมายเลขประจำตัวสถานีจาก Payload ของเซนเซอร์โหนดให้ตรงกับ Station ID ในฐานข้อมูล
8. **`gateway_mapping`**: จับคู่รหัสฮาร์ดแวร์ ChirpStack Gateway ID (Hex) ให้ตรงกับ Gateway ID ในระบบ
9. **`users`**: จัดเก็บข้อมูลบัญชีผู้ใช้งานระบบ รหัสผ่าน (bcrypt hash) และสิทธิ์การเข้าถึง (3-Tier RBAC)
10. **`line_subscribers`**: จัดเก็บข้อมูลประชาชน/ผู้ติดตามผ่าน LINE Official Account เพื่อรับการแจ้งเตือนภัยน้ำท่วม
11. **`notification_settings`**: จัดเก็บการตั้งค่าเงื่อนไขการแจ้งเตือนภัย ระดับน้ำ อัตราน้ำขึ้นฉับพลัน แบตเตอรี่ และระยะหน่วงเวลา (Cooldown)

---

## ตาราง gateway

**วัตถุประสงค์การใช้งาน:** ใช้สำหรับจัดเก็บข้อมูลและสถานะการทำงานของสถานีแม่ข่ายรับสัญญาณ LoRa Gateway ที่เชื่อมต่อกับระบบเครือข่าย

| Field | Description | Data Type | Domain | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `gateway_id` | รหัส Gateway | VARCHAR(20) | - | PK, NOT NULL |
| `gateway_name` | ชื่อ Gateway | VARCHAR(100) | - | NOT NULL |
| `ip_address` | IP หรือ network address ของ gateway | VARCHAR(50) | - | nullable |
| `last_update` | เวลา gateway ส่งข้อมูลล่าสุด | TIMESTAMP | YYYY-MM-DD HH:MM:SS | nullable |
| `status` | สถานะการทำงานของ gateway | ENUM('online','offline','maintenance') | online, offline, maintenance | NOT NULL, Default: 'offline' |

---

## ตาราง station

**วัตถุประสงค์การใช้งาน:** ใช้สำหรับจัดเก็บข้อมูลสถานีตรวจวัดระดับน้ำ ตำแหน่งทางภูมิศาสตร์ (พิกัด GPS) ค่าการปรับเทียบระยะเซนเซอร์กับระดับอ้างอิง (ตลิ่ง) และเกณฑ์ระดับน้ำเพื่อใช้ประเมินสถานการณ์น้ำ

| Field | Description | Data Type | Domain | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `station_id` | รหัสสถานี | VARCHAR(20) | - | PK, NOT NULL |
| `gateway_id` | Gateway ที่สถานีเชื่อมต่อ | VARCHAR(20) | - | FK(gateway.gateway_id), NOT NULL |
| `station_name` | ชื่อสถานี | VARCHAR(100) | - | NOT NULL |
| `station_type` | ประเภทแหล่งน้ำ/สถานี | ENUM('river','canal','reservoir','urban') | river, canal, reservoir, urban | NOT NULL, Default: 'river' |
| `location_name` | ชื่อพื้นที่/คำอธิบายสถานที่ติดตั้ง | VARCHAR(150) | - | nullable |
| `latitude` | ละติจูดของตำแหน่งติดตั้ง | DECIMAL(10,6) | -90.000000 ถึง +90.000000 | nullable |
| `longitude` | ลองจิจูดของตำแหน่งติดตั้ง | DECIMAL(10,6) | -180.000000 ถึง +180.000000 | nullable |
| `install_date` | วันที่ติดตั้งสถานี | DATE | YYYY-MM-DD | nullable |
| `status` | สถานะการทำงานของสถานี | ENUM('active','inactive','maintenance','offline') | active, inactive, maintenance, offline | NOT NULL, Default: 'active' |
| `sensor_to_ref_distance` | ระยะห่างจากเซนเซอร์ถึงจุดอ้างอิงระดับน้ำ (เมตร) | FLOAT | >= 0 | Default: 2.0 |
| `reference_point_name` | ชื่อจุดอ้างอิงระดับน้ำ (เช่น ขอบตลิ่ง) | VARCHAR(100) | - | Default: 'จุดอ้างอิง' |
| `blind_zone_offset` | ระยะบอดของเซนเซอร์อัลตราโซนิก (เมตร) | FLOAT | >= 0 | Default: 0.28 |
| `tilt_compensation_enabled` | เปิด/ปิดการคำนวณชดเชยการเอียงของทุ่น | BOOLEAN | true, false | Default: true |
| `tilt_offset_x` | ค่าชดเชยแกนเอียง X (Offset) | NUMERIC(5,2) | - | Default: 0.0 |
| `tilt_offset_y` | ค่าชดเชยแกนเอียง Y (Offset) | NUMERIC(5,2) | - | Default: 0.0 |
| `warning_level` | ระดับน้ำแจ้งเตือนเฝ้าระวัง (เมตร) | FLOAT | - | nullable |
| `critical_level` | ระดับน้ำแจ้งเตือนวิกฤต (เมตร) | FLOAT | - | nullable |
| `max_level` | ระดับน้ำสูงสุดที่ตลิ่ง/ทุ่นรับได้ (เมตร) | FLOAT | - | nullable |
| `normal_max` | ระดับน้ำปกติสูงสุด (เมตร) | FLOAT | - | nullable |

---

## ตาราง mcu

**วัตถุประสงค์การใช้งาน:** ใช้จัดเก็บข้อมูลของบอร์ดไมโครคอนโทรลเลอร์ที่ติดตั้งในแต่ละสถานีตรวจวัด ข้อมูลเวอร์ชันเฟิร์มแวร์ และสถานะความแรงสัญญาณพร้อมระดับแบตเตอรี่ล่าสุด

| Field | Description | Data Type | Domain | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `mcu_id` | รหัส MCU / DevEUI อุปกรณ์ | VARCHAR(20) | - | PK, NOT NULL |
| `station_id` | สถานีที่ MCU ประจำการอยู่ | VARCHAR(20) | - | FK(station.station_id), NOT NULL |
| `model` | รุ่นของฮาร์ดแวร์ MCU | VARCHAR(100) | - | nullable |
| `firmware_version` | เวอร์ชันเฟิร์มแวร์ | VARCHAR(50) | - | nullable |
| `signal_strength` | ความแรงสัญญาณ LoRa ล่าสุด (RSSI) | FLOAT | -140 ถึง 0 (dBm) | nullable |
| `battery_level` | ระดับเปอร์เซ็นต์แบตเตอรี่ (%) | FLOAT | 0–100% | nullable |
| `last_update` | เวลาที่ MCU รายงานข้อมูลล่าสุด | TIMESTAMP | YYYY-MM-DD HH:MM:SS (UTC) | nullable |

---

## ตาราง sensors

**วัตถุประสงค์การใช้งาน:** ใช้สำหรับจัดเก็บรายละเอียดคุณลักษณะทางเทคนิคของเซนเซอร์ตรวจวัด (เช่น ชนิด ช่วงวัด หน่วยวัด) อ้างอิงตามสเปกทางวิศวกรรม

| Field | Description | Data Type | Domain | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `sensor_id` | รหัสเซนเซอร์ | VARCHAR(20) | - | PK, NOT NULL |
| `station_id` | สถานีที่ติดตั้งเซนเซอร์ | VARCHAR(20) | - | FK(station.station_id), NOT NULL |
| `sensor_type` | ประเภทของเซนเซอร์ | ENUM('ultrasonic','pressure') | ultrasonic, pressure | NOT NULL |
| `model` | รุ่นของเซนเซอร์ | VARCHAR(100) | - | nullable |
| `unit` | หน่วยการวัด | VARCHAR(20) | เช่น m, cm, bar | nullable |
| `range_min` | ค่าต่ำสุดที่ตรวจวัดได้ | FLOAT | - | nullable |
| `range_max` | ค่าสูงสุดที่ตรวจวัดได้ | FLOAT | - | nullable |
| `status` | สถานะการทำงานของเซนเซอร์ | ENUM('active','fault','maintenance') | active, fault, maintenance | NOT NULL, Default: 'active' |

---

## ตาราง readings

**วัตถุประสงค์การใช้งาน:** ใช้จัดเก็บประวัติข้อมูลอนุกรมเวลา (Time-Series) ของการตรวจวัดระดับน้ำ สภาพแวดล้อม พลังงาน สัญญาณวิทยุ LoRaWAN และพิกัดตำแหน่งของทุ่นลอยน้ำ

| Field | Description | Data Type | Domain | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `reading_id` | รหัสลำดับการอ่านค่า | BIGSERIAL (BIGINT) | - | PK, NOT NULL |
| `station_id` | รหัสสถานีตรวจวัดต้นทาง | VARCHAR(20) | - | FK(station.station_id), NOT NULL |
| `timestamp` | วันและเวลาที่อ่านค่า | TIMESTAMP | YYYY-MM-DD HH:MM:SS (UTC) | NOT NULL, Default: NOW() |
| `raw_distance` | ระยะห่างดิบจากเซนเซอร์ถึงผิวน้ำ (เมตร) | FLOAT | >= 0 | nullable |
| `water_level` | ระดับน้ำคำนวณเทียบจุดอ้างอิง (เมตร) | FLOAT | - | nullable |
| `is_blind_zone` | ระดับน้ำอยู่ในระยะบอดเซนเซอร์หรือไม่ | BOOLEAN | true, false | Default: false |
| `temperature` | อุณหภูมิสิ่งแวดล้อม (°C) | FLOAT | - | nullable |
| `humidity` | ความชื้นสัมพัทธ์ในอากาศ (%) | FLOAT | 0–100% | nullable |
| `battery_voltage` | แรงดันไฟฟ้าแบตเตอรี่ (V) | FLOAT | 0–5 V | nullable |
| `battery_percent` | เปอร์เซ็นต์แบตเตอรี่ที่เหลือ (%) | FLOAT | 0–100% | nullable |
| `rssi` | ค่า RSSI ที่ gateway ได้รับ (dBm) | FLOAT | -140 ถึง 0 | nullable |
| `snr` | ค่า SNR (Signal-to-Noise Ratio) | FLOAT | -20 ถึง +15 (dB) | nullable |
| `tilt_x` | องศาการเอียงแกน X ของทุ่น (องศา) | FLOAT | -180 ถึง +180 | nullable |
| `tilt_y` | องศาการเอียงแกน Y ของทุ่น (องศา) | FLOAT | -180 ถึง +180 | nullable |
| `latitude` | พิกัดละติจูดขณะอ่านค่า (GPS) | DECIMAL(10,6) | -90.000000 ถึง +90.000000 | nullable |
| `longitude` | พิกัดลองจิจูดขณะอ่านค่า (GPS) | DECIMAL(10,6) | -180.000000 ถึง +180.000000 | nullable |

---

## ตาราง alerts

**วัตถุประสงค์การใช้งาน:** ใช้จัดเก็บประวัติเหตุการณ์แจ้งเตือนภัยที่เกิดขึ้นในระบบ (เช่น ระดับน้ำวิกฤต, อัตราน้ำขึ้นเร็ว, แบตเตอรี่ต่ำ, ทุ่นหลุดพิกัด) และสถานะการรับทราบ/แก้ไขเหตุการณ์

| Field | Description | Data Type | Domain | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `alert_id` | รหัสแจ้งเตือน (สร้างอัตโนมัติแบบ AL-XXX) | VARCHAR(20) | - | PK, NOT NULL |
| `station_id` | สถานีตรวจวัดจุดที่เกิดเหตุ | VARCHAR(20) | - | FK(station.station_id), NOT NULL |
| `timestamp` | วันและเวลาที่เกิดเหตุ | TIMESTAMP | YYYY-MM-DD HH:MM:SS (UTC) | NOT NULL, Default: NOW() |
| `alert_type` | ประเภทการแจ้งเตือน | ENUM('water_level','battery','offline','tilt','rate_of_rise','geofence','online') | ตามรายการ ENUM | NOT NULL |
| `value` | ค่าที่ตรวจวัดได้ทำให้เกิด alert | FLOAT | - | nullable |
| `threshold` | เกณฑ์ที่ตั้งไว้สำหรับตรวจสอบ | FLOAT | - | nullable |
| `message` | ข้อความรายละเอียดการแจ้งเตือน | VARCHAR(255) | - | nullable |
| `status` | สถานะการจัดการเหตุการณ์ | ENUM('active','acknowledged','resolved') | active, acknowledged, resolved | NOT NULL, Default: 'active' |

---

## ตาราง station_mapping

**วัตถุประสงค์การใช้งาน:** ใช้สำหรับแปลงหมายเลขสถานีที่เป็นตัวเลขจำนวนเต็ม (จาก Payload เซนเซอร์/บอร์ดส่งสัญญาณ) ให้ตรงกับรหัส Station ID (VARCHAR) ในฐานข้อมูล

| Field | Description | Data Type | Domain | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `payload_station_id` | รหัสสถานีที่เป็นตัวเลขจาก Payload อุปกรณ์ | INTEGER | 1, 2, 3, ... | PK, NOT NULL |
| `station_id` | รหัสสถานีหลักในระบบฐานข้อมูล | VARCHAR(20) | - | FK(station.station_id), NOT NULL |

---

## ตาราง gateway_mapping

**วัตถุประสงค์การใช้งาน:** ใช้สำหรับแปลงรหัส Gateway ประจำเครื่องแบบ Hex 16 ตัวอักษรที่ส่งมาจาก ChirpStack ให้ตรงกับรหัส Gateway ID ในระบบฐานข้อมูล

| Field | Description | Data Type | Domain | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `chirpstack_gateway_id` | รหัส Gateway 16 ตัวอักษร Hex จาก ChirpStack | VARCHAR(20) | 16-hex characters | PK, NOT NULL |
| `gateway_id` | รหัส Gateway หลักในระบบฐานข้อมูล | VARCHAR(20) | - | FK(gateway.gateway_id), NOT NULL |

---

## ตาราง users

**วัตถุประสงค์การใช้งาน:** ใช้สำหรับจัดเก็บข้อมูลบัญชีผู้ใช้งานระบบ การเข้ารหัสผ่านเพื่อยืนยันตัวตน และการควบคุมสิทธิ์การเข้าถึงระบบตามระดับความรับผิดชอบ (Role-Based Access Control)

| Field | Description | Data Type | Domain | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `user_id` | รหัสประจำตัวผู้ใช้งาน | SERIAL (INT) | 1, 2, 3, ... | PK, NOT NULL |
| `name` | ชื่อ-นามสกุล ของผู้ใช้งาน | VARCHAR(100) | - | NOT NULL |
| `email` | อีเมลสำหรับเข้าสู่ระบบ | VARCHAR(150) | email format | UNIQUE, NOT NULL |
| `password_hash` | รหัสผ่านที่เข้ารหัสด้วย bcrypt | VARCHAR(255) | - | NOT NULL |
| `phone` | หมายเลขโทรศัพท์ติดต่อ | VARCHAR(20) | - | nullable |
| `role` | สิทธิ์การเข้าถึงระบบ (RBAC) | ENUM('citizen','staff','admin') | citizen, staff, admin | NOT NULL, Default: 'citizen' |
| `district` | อำเภอ/เขต หรือพื้นที่สังกัด | VARCHAR(100) | - | nullable |
| `line_user_id` | LINE User ID สำหรับรับแจ้งเตือนรายบุคคล | VARCHAR(100) | - | nullable |
| `station_ids` | รายการสถานีที่รับผิดชอบ | TEXT[] | Array of station_id | NOT NULL, Default: '{}' |
| `is_active` | สถานะเปิด/ปิดการใช้งานบัญชี | BOOLEAN | true, false | NOT NULL, Default: true |
| `is_credentials_set` | ระบุว่าผู้ใช้เปลี่ยนรหัสผ่านเริ่มต้นแล้วหรือไม่ | BOOLEAN | true, false | NOT NULL, Default: false |
| `created_at` | เวลาที่สร้างบัญชีผู้ใช้ | TIMESTAMP | YYYY-MM-DD HH:MM:SS | NOT NULL, Default: NOW() |
| `updated_at` | เวลาที่แก้ไขข้อมูลบัญชีล่าสุด | TIMESTAMP | YYYY-MM-DD HH:MM:SS | NOT NULL, Default: NOW() |

---

## ตาราง line_subscribers

**วัตถุประสงค์การใช้งาน:** ใช้สำหรับจัดเก็บข้อมูลประชาชนหรือผู้ติดตามที่เพิ่มเพื่อนกับ LINE Official Account เพื่อรับการแจ้งเตือนภัยน้ำท่วมตามสถานีที่สนใจ

| Field | Description | Data Type | Domain | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `subscriber_id` | รหัสลำดับผู้ติดตาม LINE | SERIAL (INT) | 1, 2, 3, ... | PK, NOT NULL |
| `line_user_id` | รหัส LINE User ID ของผู้ติดตาม | VARCHAR(100) | - | UNIQUE, NOT NULL |
| `display_name` | ชื่อโปรไฟล์ใน LINE | VARCHAR(255) | - | nullable |
| `picture_url` | URL รูปโปรไฟล์ใน LINE | TEXT | URL | nullable |
| `station_ids` | รายการสถานีที่ผู้ใช้เลือกติดตามรับข่าวสาร | TEXT[] | Array of station_id | Default: '{}' |
| `is_active` | สถานะการเปิดรับการแจ้งเตือนภัย | BOOLEAN | true, false | Default: true |
| `created_at` | เวลาที่เพิ่มเพื่อนหรือเริ่มติดตาม | TIMESTAMPTZ | ISO 8601 Timestamp | Default: NOW() |
| `updated_at` | เวลาที่มีการแก้ไขการติดตามล่าสุด | TIMESTAMPTZ | ISO 8601 Timestamp | Default: NOW() |

---

## ตาราง notification_settings

**วัตถุประสงค์การใช้งาน:** ใช้สำหรับจัดเก็บค่าคอนฟิกูเรชันการแจ้งเตือนภัย ทั้งเกณฑ์ค่าวิกฤต การเปิด/ปิดเงื่อนไข และระยะเวลาหน่วงเวลา (Cooldown) ป้องกันการแจ้งเตือนซ้ำซ้อน ทั้งแบบค่าเริ่มต้นของทั้งระบบ (Global) และรายสถานี (Per-station override)

| Field | Description | Data Type | Domain | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `setting_id` | รหัสลำดับการตั้งค่า | SERIAL (INT) | 1, 2, 3, ... | PK, NOT NULL |
| `station_id` | รหัสสถานีเฉพาะ (NULL = ค่ากลาง Global) | VARCHAR(50) | - | UNIQUE, nullable |
| `water_level_enabled` | เปิด/ปิดการแจ้งเตือนระดับน้ำวิกฤต | BOOLEAN | true, false | Default: true |
| `safety_offset` | ระยะความปลอดภัยระดับน้ำชดเชย (เมตร) | FLOAT | >= 0 | Default: 0.0 |
| `water_level_cooldown_minutes` | ระยะเวลาหน่วงป้องกันแจ้งเตือนระดับน้ำซ้ำ (นาที) | INTEGER | >= 1 | Default: 30 |
| `rate_of_rise_enabled` | เปิด/ปิดการแจ้งเตือนอัตราน้ำขึ้นฉับพลัน | BOOLEAN | true, false | Default: true |
| `rate_of_rise_threshold` | เกณฑ์อัตราน้ำขึ้นที่ผิดปกติ (เมตร/ชม.) | FLOAT | > 0 | Default: 0.30 |
| `rate_of_rise_cooldown_minutes` | ระยะเวลาหน่วงป้องกันแจ้งเตือนน้ำขึ้นเร็วซ้ำ (นาที) | INTEGER | >= 1 | Default: 30 |
| `offline_timeout_enabled` | เปิด/ปิดการแจ้งเตือนสถานีขาดการติดต่อ | BOOLEAN | true, false | Default: true |
| `offline_timeout_minutes` | ระยะเวลาที่ไม่ได้รับข้อมูลแล้วถือว่าออฟไลน์ (นาที) | INTEGER | >= 1 | Default: 30 |
| `offline_cooldown_minutes` | ระยะเวลาหน่วงป้องกันแจ้งเตือนออฟไลน์ซ้ำ (นาที) | INTEGER | >= 1 | Default: 60 |
| `battery_low_enabled` | เปิด/ปิดการแจ้งเตือนระดับแบตเตอรี่ต่ำ | BOOLEAN | true, false | Default: true |
| `battery_low_threshold` | เกณฑ์ระดับแบตเตอรี่ต่ำ (%) | FLOAT | 0–100% | Default: 20.0 |
| `battery_low_cooldown_minutes` | ระยะเวลาหน่วงป้องกันแจ้งเตือนแบตเตอรี่ต่ำซ้ำ (นาที) | INTEGER | >= 1 | Default: 120 |
| `geofence_enabled` | เปิด/ปิดการแจ้งเตือนทุ่นหลุดตำแหน่ง | BOOLEAN | true, false | Default: true |
| `geofence_radius_meters` | รัศมีระยะปลอดภัยของทุ่นตรวจวัด (เมตร) | FLOAT | > 0 | Default: 100.0 |
| `geofence_cooldown_minutes` | ระยะเวลาหน่วงป้องกันแจ้งเตือนหลุดรัศมีซ้ำ (นาที) | INTEGER | >= 1 | Default: 60 |
| `created_at` | เวลาที่สร้างการตั้งค่า | TIMESTAMPTZ | ISO 8601 Timestamp | Default: NOW() |
| `updated_at` | เวลาที่แก้ไขการตั้งค่าล่าสุด | TIMESTAMPTZ | ISO 8601 Timestamp | Default: NOW() |
