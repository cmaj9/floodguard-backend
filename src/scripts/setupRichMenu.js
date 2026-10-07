/**
 * LINE Rich Menu Setup Script
 * Creates the Compact Rich Menu (2500x843 px) with 3 zones:
 * - Zone 1 (Left 1/3, 0-833 px): เช็กระดับน้ำ (Message: "ระดับน้ำ" -> Instant Flex Summary)
 * - Zone 2 (Center 1/3, 833-1667 px): แดชบอร์ด & แผนที่ (LIFF: /dashboard)
 * - Zone 3 (Right 1/3, 1667-2500 px): รับแจ้งเตือนภัย (LIFF: /subscribe)
 *
 * Automatically uploads the image (rich_menu_2500x843.jpg) and sets as default.
 * Usage: node src/scripts/setupRichMenu.js
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LIFF_ID = process.env.LINE_LIFF_ID || '2011710455-EuzadfEo';

const richMenuPayload = {
  size: {
    width: 2500,
    height: 843,
  },
  selected: true,
  name: 'FloodGuard Compact Menu',
  chatBarText: 'เมนูหลัก',
  areas: [
    {
      bounds: {
        x: 0,
        y: 0,
        width: 833,
        height: 843,
      },
      action: {
        type: 'message',
        label: 'เช็กระดับน้ำ',
        text: 'ระดับน้ำ',
      },
    },
    {
      bounds: {
        x: 833,
        y: 0,
        width: 834,
        height: 843,
      },
      action: {
        type: 'uri',
        label: 'แดชบอร์ด & แผนที่',
        uri: `https://liff.line.me/${LIFF_ID}/dashboard`,
      },
    },
    {
      bounds: {
        x: 1667,
        y: 0,
        width: 833,
        height: 843,
      },
      action: {
        type: 'uri',
        label: 'รับแจ้งเตือนภัย',
        uri: `https://liff.line.me/${LIFF_ID}/subscribe`,
      },
    },
  ],
};

function findImageFile() {
  const candidates = [
    path.resolve(__dirname, '../assets/rich_menu_2500x843.jpg'),
    path.resolve(__dirname, '../../../Project_FontEnd/public/rich_menu_2500x843.jpg'),
    path.resolve(__dirname, '../../assets/rich_menu_2500x843.jpg'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function createRichMenu() {
  if (!LINE_TOKEN) {
    console.error('[ERROR] Missing LINE_CHANNEL_ACCESS_TOKEN in .env');
    process.exit(1);
  }

  try {
    // 0. Clean up old rich menus if any
    console.log('[0/4] Checking existing rich menus...');
    const listRes = await fetch('https://api.line.me/v2/bot/richmenu/list', {
      headers: { Authorization: `Bearer ${LINE_TOKEN}` },
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      for (const rm of listData.richmenus || []) {
        console.log(`[CLEANUP] Deleting old rich menu ${rm.richMenuId}...`);
        await fetch(`https://api.line.me/v2/bot/richmenu/${rm.richMenuId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${LINE_TOKEN}` },
        });
      }
    }

    // 1. Create Rich Menu structure
    console.log('[1/4] Creating Rich Menu on LINE API...');
    const res = await fetch('https://api.line.me/v2/bot/richmenu', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      body: JSON.stringify(richMenuPayload),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('[ERROR] Failed to create Rich Menu:', data);
      return;
    }

    const richMenuId = data.richMenuId;
    console.log(`[OK] Rich Menu created with ID: ${richMenuId}`);

    // 2. Upload image content
    const imagePath = findImageFile();
    if (!imagePath) {
      console.error('[ERROR] rich_menu_2500x843.jpg not found in candidate paths!');
      return;
    }

    console.log(`[2/4] Uploading image (${imagePath})...`);
    const imageBuffer = fs.readFileSync(imagePath);
    const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      body: imageBuffer,
    });

    if (!uploadRes.ok) {
      const uploadErr = await uploadRes.text();
      console.error('[ERROR] Failed to upload Rich Menu image:', uploadErr);
      return;
    }
    console.log('[OK] Rich Menu image uploaded successfully!');

    // 3. Set as default for all users
    console.log('[3/4] Setting as default Rich Menu for all users...');
    const defRes = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
    });

    if (defRes.ok) {
      console.log(`[OK] Rich Menu set as default for all users!`);
    } else {
      const defData = await defRes.text();
      console.error(`[ERROR] Default set returned: ${defData}`);
      return;
    }

    // 4. Verify default rich menu
    const verifyRes = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
      headers: { Authorization: `Bearer ${LINE_TOKEN}` },
    });
    if (verifyRes.ok) {
      const verifyData = await verifyRes.json();
      console.log(`[4/4] Verification OK: Active default Rich Menu ID is ${verifyData.richMenuId}`);
    }

    return richMenuId;
  } catch (err) {
    console.error('[ERROR]', err.message);
  }
}

if (require.main === module) {
  createRichMenu();
}

module.exports = { richMenuPayload, createRichMenu };
