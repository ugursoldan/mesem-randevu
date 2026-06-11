const express = require('express');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Database Setup ---
const dbPath = path.join(__dirname, 'data', 'mesem.db');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    student_name TEXT NOT NULL,
    birth_date TEXT NOT NULL DEFAULT '',
    parent_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    grade TEXT NOT NULL,
    department TEXT NOT NULL,
    date TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled','completed')),
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);

// Seed admin user (simple - no auth for now, just a password check)
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);
const adminPass = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');
if (!adminPass) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('admin_password', 'mesem2025');
}

// Available time slots
const TIME_SLOTS = [
  '09:00-09:20', '09:20-09:40', '09:40-10:00',
  '10:00-10:20', '10:20-10:40', '10:40-11:00',
  '11:00-11:20', '11:20-11:40', '11:40-12:00',
  '13:00-13:20', '13:20-13:40', '13:40-14:00',
  '14:00-14:20', '14:20-14:40', '14:40-15:00',
  '15:00-15:20', '15:20-15:40', '15:40-16:00'
];

const DEPARTMENTS = [
  'Güzellik ve Saç Bakımı Hizmetleri',
  'Elektrik Elektronik Teknolojisi',
  'Motorlu Araçlar Teknolojisi',
  'Muhasebe ve Finansman',
  'Tesisat Teknolojisi ve İklimlendirme',
  'Yiyecek İçecek Hizmetleri'
];

const GRADES = ['9. Sınıf', '10. Sınıf', '11. Sınıf', '12. Sınıf'];

// --- API Routes ---

// Get available slots for a date
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  if (!date) return res.json({ slots: TIME_SLOTS });

  const taken = db.prepare(
    "SELECT time_slot FROM appointments WHERE date = ? AND status != 'cancelled'"
  ).all(date);
  const takenSlots = new Set(taken.map(t => t.time_slot));

  const available = TIME_SLOTS.filter(s => !takenSlots.has(s));
  res.json({ date, available, all_slots: TIME_SLOTS, taken: [...takenSlots] });
});

// Create appointment
app.post('/api/appointments', (req, res) => {
  const { student_name, birth_date, parent_name, phone, grade, department, date, time_slot, notes } = req.body;

  // Validate required fields
  if (!student_name || !birth_date || !parent_name || !phone || !grade || !department || !date || !time_slot) {
    return res.status(400).json({ error: 'Tüm zorunlu alanları doldurun' });
  }

  // Validate time slot
  if (!TIME_SLOTS.includes(time_slot)) {
    return res.status(400).json({ error: 'Geçersiz saat dilimi' });
  }

  // Check slot availability
  const existing = db.prepare(
    "SELECT id FROM appointments WHERE date = ? AND time_slot = ? AND status != 'cancelled'"
  ).get(date, time_slot);
  if (existing) {
    return res.status(409).json({ error: 'Bu saat dilimi dolu. Lütfen başka bir saat seçin.' });
  }

  const id = uuidv4().slice(0, 8);
  db.prepare(`
    INSERT INTO appointments (id, student_name, birth_date, parent_name, phone, grade, department, date, time_slot, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, student_name, birth_date, parent_name, phone, grade, department, date, time_slot, notes || '');

  res.json({ success: true, id, message: 'Randevunuz başarıyla oluşturuldu!' });
});

// Get appointment by id
app.get('/api/appointments/:id', (req, res) => {
  const apt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!apt) return res.status(404).json({ error: 'Randevu bulunamadı' });
  res.json(apt);
});

// Get appointments by phone number (public)
app.get('/api/my-appointments', (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'Telefon numarası gerekli' });

  const appointments = db.prepare(
    "SELECT * FROM appointments WHERE phone = ? ORDER BY date DESC, time_slot DESC"
  ).all(phone);
  res.json(appointments);
});

// Cancel appointment (public)
app.post('/api/appointments/:id/cancel', (req, res) => {
  const result = db.prepare(
    "UPDATE appointments SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(req.params.id);
  if (result.changes === 0) return res.status(400).json({ error: 'Randevu iptal edilemez veya bulunamadı' });
  res.json({ success: true, message: 'Randevunuz iptal edildi' });
});

// --- Admin Routes ---

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');
  if (password === stored.value) {
    const token = uuidv4();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_token', token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Hatalı şifre' });
  }
});

// Admin middleware
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_token');
  if (token && stored && token === stored.value) {
    next();
  } else {
    res.status(401).json({ error: 'Yetkisiz erişim' });
  }
}

// Get all appointments (admin)
app.get('/api/admin/appointments', adminAuth, (req, res) => {
  const { date, status } = req.query;
  let query = 'SELECT * FROM appointments WHERE 1=1';
  const params = [];

  if (date) { query += ' AND date = ?'; params.push(date); }
  if (status) { query += ' AND status = ?'; params.push(status); }

  query += ' ORDER BY date ASC, time_slot ASC';
  const appointments = db.prepare(query).all(...params);
  res.json(appointments);
});

// Update appointment status (admin)
app.put('/api/admin/appointments/:id', adminAuth, (req, res) => {
  const { status } = req.body;
  if (!['pending', 'confirmed', 'cancelled', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'Geçersiz durum' });
  }
  const result = db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Randevu bulunamadı' });
  res.json({ success: true });
});

// Get stats (admin)
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM appointments').get();
  const pending = db.prepare("SELECT COUNT(*) as count FROM appointments WHERE status = 'pending'").get();
  const confirmed = db.prepare("SELECT COUNT(*) as count FROM appointments WHERE status = 'confirmed'").get();
  const today = db.prepare(
    "SELECT COUNT(*) as count FROM appointments WHERE date = date('now','localtime') AND status != 'cancelled'"
  ).get();

  res.json({
    total: total.count,
    pending: pending.count,
    confirmed: confirmed.count,
    today: today.count
  });
});

// Change admin password
app.post('/api/admin/change-password', adminAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');
  if (currentPassword !== stored.value) {
    return res.status(400).json({ error: 'Mevcut şifre hatalı' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Yeni şifre en az 4 karakter olmalı' });
  }
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(newPassword, 'admin_password');
  res.json({ success: true, message: 'Şifre değiştirildi' });
});

// --- Serve Frontend ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/info', (req, res) => {
  res.json({
    departments: DEPARTMENTS,
    grades: GRADES,
    timeSlots: TIME_SLOTS
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📅 MESEM Randevu Sistemi çalışıyor: http://localhost:${PORT}`);
  console.log(`👨‍🎓 Öğrenci sayfası: http://localhost:${PORT}`);
  console.log(`🔐 Admin paneli: http://localhost:${PORT}/admin`);
});
