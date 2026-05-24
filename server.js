const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

const allowedOrigins = [
  'http://localhost:3000',
  'https://template-store-dashboard.vercel.app',
  'https://template-store-dashboard-hyb3ynf3g-stew02-s-projects1.vercel.app'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
}));

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});


pool.connect((err, client, release) => {
  if (err) {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  } else {
    console.log('Database connected successfully');
    release();
  }
});

app.get('/', (req, res) => res.send('Backend is alive!'));
app.get('/api/test', (req, res) => res.json({ message: 'API is working!' }));

const generatePayHereHash = (orderId, amount) => {
  const merchantId = '1234923';
  const merchantSecretBase64 = 'NzIxNTYzNjYyMTYwOTU4NjUyMzIzODM1MTEyMzE2MDA1MTcxNzY=';
  const currency = 'LKR';
  const amountFormatted = parseFloat(amount).toFixed(2);
  const secret = Buffer.from(merchantSecretBase64, 'base64').toString();
  const md5Secret = crypto.createHash('md5').update(secret).digest('hex').toUpperCase();
  const hashString = merchantId + orderId + amountFormatted + currency + md5Secret;
  return crypto.createHash('md5').update(hashString).digest('hex').toUpperCase();
};

app.post('/api/payhere-hash', (req, res) => {
  const { orderId, amount } = req.body;
  if (!orderId || !amount) {
    return res.status(400).json({ error: 'Missing orderId or amount' });
  }
  const hash = generatePayHereHash(orderId, amount);
  res.json({ hash });
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY order_index');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/templates', async (req, res) => {
  const { category } = req.query;
  try {
    let query = `
      SELECT t.*, c.name as category_name 
      FROM templates t 
      JOIN categories c ON t.category_id = c.id
    `;
    const params = [];
    if (category) {
      query += ' WHERE c.name = $1';
      params.push(category);
    }
    query += ' ORDER BY t.name';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/features', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM additional_features ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders', async (req, res) => {
  const { templateId, selectedFeatures, totalAmount, paymentMethod } = req.body;
  try {
    const orderUuid = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    const status = 'pending';
    const currency = 'LKR';
    const selectedFeaturesJson = JSON.stringify(selectedFeatures || []);
    
    const query = `
      INSERT INTO orders (order_uuid, template_id, total_amount, currency, status, selected_features, payment_method)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
    const values = [orderUuid, templateId, totalAmount, currency, status, selectedFeaturesJson, paymentMethod];
    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:orderUuid', async (req, res) => {
  const { orderUuid } = req.params;
  const { status } = req.body;
  try {
    const result = await pool.query('UPDATE orders SET status = $1 WHERE order_uuid = $2 RETURNING *', [status, orderUuid]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/:orderUuid', async (req, res) => {
  const { orderUuid } = req.params;
  try {
    const result = await pool.query('SELECT * FROM orders WHERE order_uuid = $1', [orderUuid]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.post('/api/bank-order', upload.single('slip'), async (req, res) => {
  const { orderUuid, customerName, customerEmail, customerPhone, orderNote, paymentMethod } = req.body;
  if (!orderUuid || !customerName || !customerEmail) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const backendUrl = process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const slipUrl = req.file ? `${backendUrl}/uploads/${req.file.filename}` : null;
  const referenceCode = `BANK${Date.now()}${Math.floor(Math.random() * 10000)}`;

  try {
    await pool.query(
      `INSERT INTO orders (order_uuid, template_id, total_amount, currency, status, payment_method)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       ON CONFLICT (order_uuid) DO NOTHING`,
      [orderUuid, req.body.templateId || 1, req.body.totalAmount || 0, 'LKR', paymentMethod || 'bank']
    );

    await pool.query(
      `INSERT INTO bank_orders (order_uuid, payment_method, customer_name, customer_email, customer_phone, order_note, slip_image_url, reference_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [orderUuid, paymentMethod || 'bank', customerName, customerEmail, customerPhone, orderNote, slipUrl, referenceCode]
    );
    res.json({ success: true, message: 'Order placed. Awaiting verification.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to place order' });
  }
});

app.get('/api/admin/bank-orders', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT bo.*, o.template_id, o.total_amount, t.name as template_name
      FROM bank_orders bo
      JOIN orders o ON bo.order_uuid = o.order_uuid
      JOIN templates t ON o.template_id = t.id
      WHERE bo.status = 'pending'
      ORDER BY bo.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/verify-bank-order/:orderUuid', async (req, res) => {
  const { orderUuid } = req.params;
  const { action, adminNote, templateLink } = req.body;
  try {
    if (action === 'approve') {
      await pool.query(
        `UPDATE bank_orders SET status = 'approved', admin_note = $1 WHERE order_uuid = $2`,
        [adminNote || '', orderUuid]
      );
      await pool.query(`UPDATE orders SET status = 'paid' WHERE order_uuid = $1`, [orderUuid]);

      try {
        const bankOrder = await pool.query(`SELECT customer_email, customer_name FROM bank_orders WHERE order_uuid = $1`, [orderUuid]);
        const customerEmail = bankOrder.rows[0]?.customer_email;
        if (customerEmail && templateLink) {
          await transporter.sendMail({
            to: customerEmail,
            subject: 'Your Template Download Link',
            html: `
              <h3>Payment Verified!</h3>
              <p>Dear ${bankOrder.rows[0].customer_name},</p>
              <p>Thank you for your payment. You can now download your template using the link below:</p>
              <a href="${templateLink}">${templateLink}</a>
              <p>Best regards,<br/>InviteYou.lk Team</p>
            `
          });
        }
      } catch (emailErr) {
        console.error('Email sending failed:', emailErr.message);
      }

    } else if (action === 'reject') {
      await pool.query(
        `UPDATE bank_orders SET status = 'rejected', admin_note = $1 WHERE order_uuid = $2`,
        [adminNote || '', orderUuid]
      );
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));