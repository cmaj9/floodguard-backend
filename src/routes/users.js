const express = require('express');
const router = express.Router();
const userService = require('../services/userService');

// ── POST /api/users/login (or /api/auth/login) ─────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'กรุณากรอกอีเมลและรหัสผ่าน' });
    }
    const user = await userService.loginUser(email, password);
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

// ── POST /api/users/register (or /api/auth/register) ───────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone, district, stationIds } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'กรุณากรอกชื่อ-นามสกุล' });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, error: 'กรุณากรอกอีเมล' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร' });
    }
    const citizen = await userService.registerCitizenEmail({
      name,
      email,
      password,
      phone,
      district,
      stationIds,
    });
    res.status(201).json({
      success: true,
      data: citizen,
      message: 'ลงทะเบียนประชาชนสำเร็จเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('[API /register] Error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── POST /api/users/citizen-register ─────────────────────────────
router.post('/citizen-register', async (req, res) => {
  try {
    const { lineUserId, displayName, phone, district, stationIds } = req.body;
    if (!lineUserId) {
      return res.status(400).json({ success: false, error: 'กรุณาระบุ LINE User ID' });
    }
    const citizen = await userService.registerCitizen({
      lineUserId,
      name: displayName || 'ประชาชนผู้ใช้งาน',
      phone: phone || '',
      district: district || '',
      stationIds: stationIds || [],
    });
    res.json({
      success: true,
      data: citizen,
      message: 'ลงทะเบียนประชาชนสำเร็จเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('[API /users/citizen-register] Error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── POST /api/users/setup-credentials ─────────────────────────────
router.post('/setup-credentials', async (req, res) => {
  try {
    const { userId, lineUserId, email, password } = req.body;
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, error: 'กรุณากรอกอีเมล' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร' });
    }
    if (!userId && !lineUserId) {
      return res.status(400).json({ success: false, error: 'ไม่พบข้อมูลยืนยันตัวตนของผู้ใช้ (userId หรือ lineUserId)' });
    }

    const updatedUser = await userService.setupCitizenCredentials({
      userId,
      lineUserId,
      email,
      password,
    });

    res.json({
      success: true,
      data: updatedUser,
      message: 'ตั้งค่าอีเมลและรหัสผ่านสำเร็จเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('[API /users/setup-credentials] Error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── GET /api/users/citizen-status/:lineUserId ────────────────────
router.get('/citizen-status/:lineUserId', async (req, res) => {
  try {
    const { lineUserId } = req.params;
    const citizen = await userService.getCitizenByLineId(lineUserId);
    res.json({
      success: true,
      registered: !!citizen,
      data: citizen,
    });
  } catch (err) {
    console.error('[API /users/citizen-status] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── GET /api/users ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { role } = req.query;
    const users = await userService.getAllUsers(role);
    res.json({ success: true, data: users, count: users.length });
  } catch (err) {
    console.error('[API /users] Error:', err.message);
    res.status(500).json({ success: false, error: 'ไม่สามารถดึงข้อมูลผู้ใช้ได้' });
  }
});

// ── POST /api/users/change-password ──────────────────────────────
router.post('/change-password', async (req, res) => {
  try {
    const { userId, currentPassword, newPassword } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'ไม่พบรหัสผู้ใช้' });
    }
    const result = await userService.changePassword(userId, currentPassword, newPassword);
    res.json({ success: true, data: result, message: result.message });
  } catch (err) {
    console.error('[API /users/change-password] Error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── GET /api/users/:id ────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const user = await userService.getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'ไม่พบผู้ใช้นี้' });
    }
    res.json({ success: true, data: user });
  } catch (err) {
    console.error('[API /users/:id] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/users ───────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    if (req.body.password && req.body.password.trim().length < 6) {
      return res.status(400).json({ success: false, error: 'รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร' });
    }
    const user = await userService.createUser(req.body);
    res.status(201).json({ success: true, data: user, message: 'สร้างผู้ใช้สำเร็จ' });
  } catch (err) {
    console.error('[API POST /users] Error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── PUT /api/users/:id ────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    if (req.body.password && req.body.password.trim().length < 6) {
      return res.status(400).json({ success: false, error: 'รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร' });
    }
    const user = await userService.updateUser(req.params.id, req.body);
    res.json({ success: true, data: user, message: 'อัปเดตข้อมูลผู้ใช้สำเร็จ' });
  } catch (err) {
    console.error('[API PUT /users/:id] Error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/users/:id ─────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await userService.deleteUser(req.params.id);
    res.json({ success: true, data: deleted, message: 'ลบผู้ใช้สำเร็จ' });
  } catch (err) {
    console.error('[API DELETE /users/:id] Error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
