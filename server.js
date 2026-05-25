require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const fileUpload = require('express-fileupload');

// PDF Parse
const pdf = require('pdf-parse');

const app = express();
app.use(cors());
app.use(express.json());
app.use(fileUpload({
  limits: { fileSize: 10 * 1024 * 1024 },
}));

console.log('Claude API Key loaded?', process.env.CLAUDE_API_KEY ? 'YES' : 'NO');

// SANDBOX CONFIGURATION
const PILOTPAY_CONFIG = {
  apiKey: 'ppk_Zf3GX-MhrqR-nOJitVB2b2ZWvBTYjYe9z0lGsuk7CC0',
  baseUrl: 'https://sandbox.pilotpay.io/api/v1/core',
  isSandbox: true
};

const YOUR_DOMAIN = process.env.DOMAIN_URL || 'https://airesumerefine.com';

// ============= PAYMENT ENDPOINTS =============
app.post('/api/create-payment', async (req, res) => {
  console.log('Received Direct API request:', req.body);
  
  const {
    extOrderId,
    email,
    amount,
    currency: originalCurrency,
    cardNumber,
    expiryMonth,
    expiryYear,
    cvv,
    firstName,
    lastName,
    billingAddress
  } = req.body;

  let finalAmount = amount;
  let finalCurrency = originalCurrency;
  let conversionApplied = false;

  if (originalCurrency === 'USD') {
    finalAmount = amount;
    finalCurrency = 'USD';
    conversionApplied = false;
    console.log('💰 Currency is already USD - no conversion applied');
  } else if (originalCurrency === 'EUR') {
    finalAmount = (parseFloat(amount) * 1.17).toFixed(2);
    finalCurrency = 'USD';
    conversionApplied = true;
    console.log(`🔄 Converted EUR ${amount} to USD ${finalAmount} (rate: 1.17)`);
  } else if (originalCurrency === 'GBP') {
    finalAmount = (parseFloat(amount) * 1.27).toFixed(2);
    finalCurrency = 'USD';
    conversionApplied = true;
    console.log(`🔄 Converted GBP ${amount} to USD ${finalAmount} (rate: 1.27)`);
  } else if (originalCurrency === 'CAD') {
    finalAmount = (parseFloat(amount) * 0.73).toFixed(2);
    finalCurrency = 'USD';
    conversionApplied = true;
    console.log(`🔄 Converted CAD ${amount} to USD ${finalAmount} (rate: 0.73)`);
  } else if (originalCurrency === 'AUD') {
    finalAmount = (parseFloat(amount) * 0.66).toFixed(2);
    finalCurrency = 'USD';
    conversionApplied = true;
    console.log(`🔄 Converted AUD ${amount} to USD ${finalAmount} (rate: 0.66)`);
  } else {
    finalAmount = (parseFloat(amount) * 1.17).toFixed(2);
    finalCurrency = 'USD';
    conversionApplied = true;
    console.log(`⚠️ Unknown currency ${originalCurrency} - default conversion applied`);
  }
  
  const paymentData = {
    returnUrl: `${YOUR_DOMAIN}/payment-success?order=${extOrderId}`,
    extOrderId: String(extOrderId),
    email: email,
    description: "CV Optimization",
    tag: `order-${extOrderId}`,
    amount: finalAmount,
    currency: finalCurrency,
    type: "fiat",
    method: "card",
    additions: {
      email: email,
      card_number: cardNumber.replace(/\s/g, ''),
      card_expiry_month: expiryMonth,
      card_expiry_year: expiryYear,
      card_cvv: cvv,
      first_name: firstName,
      last_name: lastName,
      billing_country: billingAddress?.country || "US",
      billing_address: billingAddress?.street || "",
      billing_city: billingAddress?.city || "",
      billing_zip: billingAddress?.zipCode || ""
    }
  };

  const uniqueRequestId = crypto.randomUUID();

  try {
    const response = await axios.post(
      `${PILOTPAY_CONFIG.baseUrl}/payment`,
      paymentData,
      {
        headers: {
          'api-key': PILOTPAY_CONFIG.apiKey,
          'x-request-id': uniqueRequestId,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    console.log('✅ PilotPay Success:', response.status);
    
    let redirectUrl = null;
    if (response.data.context?.paymentDetails?.url) {
      redirectUrl = response.data.context.paymentDetails.url;
    } else if (response.data.context?.redirectUrl) {
      redirectUrl = response.data.context.redirectUrl;
    } else if (response.data.redirectUrl) {
      redirectUrl = response.data.redirectUrl;
    }
    
    if (redirectUrl) {
      res.json({
        success: true,
        requiresRedirect: true,
        redirectUrl: redirectUrl,
        paymentId: response.data.shortId,
        conversion_applied: conversionApplied
      });
    } else if (response.data.status === 'SUCCESS') {
      res.json({
        success: true,
        status: 'SUCCESS',
        paymentId: response.data.shortId,
        conversion_applied: conversionApplied
      });
    } else {
      res.json({
        success: true,
        paymentId: response.data.shortId,
        status: response.data.status,
        requiresPolling: true,
        conversion_applied: conversionApplied
      });
    }
    
  } catch (error) {
    console.error('❌ PilotPay Error:', error.response?.status);
    console.error('Error Data:', JSON.stringify(error.response?.data, null, 2));
    
    if (error.response?.data?.errors) {
      const errorMessages = error.response.data.errors.map(e => e.message).join(', ');
      res.status(400).json({ success: false, error: errorMessages });
    } else {
      res.status(400).json({ 
        success: false, 
        error: error.response?.data?.message || 'Payment processing failed' 
      });
    }
  }
});

app.get('/api/payment-status/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  
  try {
    const response = await axios.get(
      `${PILOTPAY_CONFIG.baseUrl}/payment/${paymentId}`,
      { headers: { 'api-key': PILOTPAY_CONFIG.apiKey } }
    );
    
    res.json({ status: response.data.status });
  } catch (error) {
    console.error('Status check error:', error.message);
    res.status(400).json({ error: 'Failed to fetch payment status' });
  }
});

// ============= DATABASE SETUP =============
const db = new sqlite3.Database(path.join(__dirname, 'resume_refiner.db'));

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    name TEXT DEFAULT '',
    password_hash TEXT,
    plan TEXT,
    max_optimizations INTEGER DEFAULT 10,
    optimizations_used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS optimization_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    original_resume TEXT,
    job_description TEXT,
    optimized_resume TEXT,
    match_score INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Add columns if needed (safe to keep - they won't error if columns exist)
  db.run(`ALTER TABLE users ADD COLUMN name TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN max_optimizations INTEGER DEFAULT 10`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN optimizations_used INTEGER DEFAULT 0`, () => {});
  
  // Update existing users based on plan
  db.run(`UPDATE users SET max_optimizations = 10 WHERE plan = 'basic' AND (max_optimizations IS NULL OR max_optimizations = 0)`);
  db.run(`UPDATE users SET max_optimizations = 20 WHERE plan = 'advance' AND (max_optimizations IS NULL OR max_optimizations = 0)`);
  db.run(`UPDATE users SET max_optimizations = 30 WHERE plan = 'top' AND (max_optimizations IS NULL OR max_optimizations = 0)`);
  db.run(`UPDATE users SET optimizations_used = 0 WHERE optimizations_used IS NULL`);
  
  // Create demo user
  db.get(`SELECT * FROM users WHERE email = 'demo@airesumerefine.com'`, (err, user) => {
    if (!user) {
      db.run(`INSERT INTO users (email, name, password_hash, plan, max_optimizations, optimizations_used) VALUES (?, ?, ?, ?, ?, ?)`, 
        ['demo@airesumerefine.com', 'Demo User', 'demo_hash', 'top', 30, 0]);
      console.log('✅ Demo user created');
    }
  });
});

// Root route
app.get('/', (req, res) => {
  res.send('✅ Resume Refiner Backend is running');
});

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_change_this';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Access denied' });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

async function extractTextFromFile(file) {
  const fileName = file.name;
  const fileExtension = fileName.split('.').pop().toLowerCase();
  
  try {
    if (fileExtension === 'pdf') {
      const data = await pdf(file.data);
      return data.text;
    } 
    else if (fileExtension === 'txt') {
      return file.data.toString('utf8');
    }
    else {
      return "Unsupported file format. Please upload PDF or TXT.";
    }
  } catch (error) {
    console.error('File extraction error:', error);
    return "Could not extract text from file.";
  }
}

// ============= TEST CLAUDE API ENDPOINT =============
app.get('/api/test-claude', async (req, res) => {
  try {
    console.log('🔍 Testing Claude API connection...');
    
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [
        { role: 'user', content: 'Say "API works!"' }
      ]
    }, {
      headers: {
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    console.log('✅ Claude API test successful!');
    res.json({ success: true, message: response.data.content[0].text });
    
  } catch (error) {
    console.error('❌ Claude API test failed:');
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============= DEMO LOGIN =============
app.post('/api/demo-login', async (req, res) => {
  try {
    const email = req.query.email || req.body.email || 'demo@airesumerefine.com';
    
    db.get(`SELECT id, email, name, plan, max_optimizations, optimizations_used,
                   (max_optimizations - optimizations_used) as remaining_optimizations 
            FROM users WHERE email = ?`, [email], (err, user) => {
      if (err || !user) {
        return res.status(500).json({ error: 'Demo user not found' });
      }
      
      const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET);
      
      // Return camelCase for frontend
      res.json({ 
        success: true, 
        token, 
        user: { 
          id: user.id,
          email: user.email,
          name: user.name || '',
          plan: user.plan,
          maxOptimizations: user.max_optimizations,
          optimizationsUsed: user.optimizations_used,
          remainingOptimizations: user.remaining_optimizations
        } 
      });
    });
  } catch (error) {
    console.error('Demo login error:', error);
    res.status(500).json({ error: 'Demo login failed' });
  }
});

// ============= LOGIN ENDPOINT =============
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  
  db.get(`SELECT id, email, name, plan, max_optimizations, optimizations_used,
                 (max_optimizations - optimizations_used) as remaining_optimizations,
                 password_hash 
          FROM users WHERE email = ?`, [email], async (err, user) => {
    
    if (err || !user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    let valid = false;
    if (user.password_hash === 'demo_hash') {
      valid = (password === 'demo123');
    } else {
      valid = await bcrypt.compare(password, user.password_hash);
    }
    
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET);
    
    // Return camelCase for frontend
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name || '',
        plan: user.plan,
        maxOptimizations: user.max_optimizations,
        optimizationsUsed: user.optimizations_used,
        remainingOptimizations: user.remaining_optimizations
      }
    });
  });
});

// ============= UPDATE USER PROFILE =============
app.put('/api/user/profile', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const { name, email } = req.body;
  
  db.run(`UPDATE users SET name = ?, email = ? WHERE id = ?`, [name, email, userId], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Failed to update profile' });
    }
    res.json({ success: true, name, email });
  });
});

// ============= UPDATE PASSWORD =============
app.put('/api/user/password', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const { currentPassword, newPassword } = req.body;
  
  db.get(`SELECT password_hash FROM users WHERE id = ?`, [userId], async (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    let valid = false;
    if (user.password_hash === 'demo_hash') {
      valid = (currentPassword === 'demo123');
    } else {
      valid = await bcrypt.compare(currentPassword, user.password_hash);
    }
    
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hashedPassword, userId]);
    res.json({ success: true });
  });
});

// ============= CV OPTIMIZATION =============
app.post('/api/optimize-resume', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { jobDescription } = req.body;
    
    if (!req.files || !req.files.resume) {
      return res.status(400).json({ error: 'Resume file is required' });
    }
    
    const resumeFile = req.files.resume;
    
    db.get(`SELECT * FROM users WHERE id = ?`, [userId], async (err, user) => {
      if (err || !user) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      const remainingOptimizations = user.max_optimizations - user.optimizations_used;
      if (remainingOptimizations <= 0) {
        return res.status(402).json({ 
          error: `You've used all ${user.max_optimizations} optimizations. Please upgrade.` 
        });
      }
      
      const resumeText = await extractTextFromFile(resumeFile);
      
      if (!resumeText || resumeText.length < 50) {
        return res.status(400).json({ error: 'Could not extract enough text from your file.' });
      }
      
      const claudeModels = {
        basic: 'claude-haiku-4-5-20251001',
        advance: 'claude-sonnet-4-5-20250929',
        top: 'claude-opus-4-5-20251101'
      };
      
      const model = claudeModels[user.plan?.toLowerCase()] || 'claude-sonnet-4-5-20250929';
      
      const prompts = {
        basic: `Return ONLY valid JSON: {"optimizedResume": "...", "matchScore": 85}`,
        advance: `Return ONLY valid JSON: {"optimizedResume": "...", "matchScore": 85, "missingKeywords": [...], "suggestions": [...]}`,
        top: `Return ONLY valid JSON: {"optimizedResume": "...", "matchScore": 85, "missingKeywords": [...], "suggestions": [...], "atsScore": 85, "linkedinSummary": "..."}`
      };
      
      const systemPrompt = prompts[user.plan?.toLowerCase()] || prompts.basic;
      
      const response = await axios.post('https://api.anthropic.com/v1/messages', {
        model: model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: `RESUME:\n${resumeText}\n\nJOB DESCRIPTION:\n${jobDescription}` }]
      }, {
        headers: {
          'x-api-key': process.env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        timeout: 90000
      });
      
      let result;
      try {
        let aiResponse = response.data.content[0].text;
        aiResponse = aiResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        result = JSON.parse(aiResponse);
      } catch (parseError) {
        return res.status(500).json({ error: 'AI returned invalid response format' });
      }
      
      db.run(`UPDATE users SET optimizations_used = optimizations_used + 1 WHERE id = ?`, [userId]);
      
      db.run(`INSERT INTO optimization_history (user_id, original_resume, job_description, optimized_resume, match_score) VALUES (?, ?, ?, ?, ?)`,
        [userId, resumeText.substring(0, 1000), jobDescription, result.optimizedResume, result.matchScore]);
      
      db.get(`SELECT max_optimizations, optimizations_used, (max_optimizations - optimizations_used) as remaining_optimizations FROM users WHERE id = ?`, [userId], (err, updatedUser) => {
        res.json({ ...result, remainingOptimizations: updatedUser.remaining_optimizations });
      });
    });
  } catch (error) {
    console.error('Optimization error:', error);
    res.status(500).json({ error: 'AI optimization failed' });
  }
});

// ============= GET DASHBOARD INFO =============
// ============= GET DASHBOARD INFO =============
app.get('/api/dashboard', authenticateToken, (req, res) => {
  db.get(`SELECT id, email, name, plan, max_optimizations, optimizations_used,
                 (max_optimizations - optimizations_used) as remaining_optimizations 
          FROM users WHERE id = ?`, [req.user.userId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    
    // Convert snake_case to camelCase for frontend
    res.json({
      id: user.id,
      email: user.email,
      name: user.name || '',
      plan: user.plan,
      maxOptimizations: user.max_optimizations,
      optimizationsUsed: user.optimizations_used,
      remainingOptimizations: user.remaining_optimizations
    });
  });
});

// ============= GET HISTORY =============
app.get('/api/history', authenticateToken, (req, res) => {
  db.all(`SELECT id, job_description, optimized_resume, match_score, created_at 
          FROM optimization_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    [req.user.userId], (err, rows) => {
    res.json(rows || []);
  });
});

// ============= DELETE HISTORY =============
app.delete('/api/history/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  
  db.get(`SELECT user_id FROM optimization_history WHERE id = ?`, [id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Not found' });
    if (row.user_id !== userId) return res.status(403).json({ error: 'Unauthorized' });
    
    db.run(`DELETE FROM optimization_history WHERE id = ?`, [id]);
    res.json({ success: true });
  });
});

app.delete('/api/history', authenticateToken, (req, res) => {
  db.run(`DELETE FROM optimization_history WHERE user_id = ?`, [req.user.userId]);
  res.json({ success: true });
});

// ============= FORGOT PASSWORD =============
// Store reset tokens temporarily
const resetTokens = new Map();

app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  
  db.get(`SELECT id, email FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err || !user) {
      // For security, don't reveal if email exists or not
      return res.json({ success: true, message: 'If your email exists in our system, you will receive a reset link.' });
    }
    
    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 3600000; // 1 hour
    
    resetTokens.set(resetToken, {
      userId: user.id,
      email: user.email,
      expiresAt: expiresAt
    });
    
    // In production, send actual email
    // For now, log the reset link
    const resetLink = `https://pilotpay-backend.onrender.com/reset-password?token=${resetToken}`;
    console.log(`🔐 Password reset link for ${email}: ${resetLink}`);
    
    // TODO: Send email with reset link
    // await sendEmail(email, 'Password Reset', `Click here to reset: ${resetLink}`);
    
    res.json({ 
      success: true, 
      message: 'If your email exists in our system, you will receive a reset link.',
      // Remove this in production - only for testing
      devLink: resetLink 
    });
  });
});

// ============= RESET PASSWORD WITH TOKEN =============
app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password required' });
  }
  
  const resetData = resetTokens.get(token);
  
  if (!resetData) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }
  
  if (Date.now() > resetData.expiresAt) {
    resetTokens.delete(token);
    return res.status(400).json({ error: 'Reset token has expired' });
  }
  
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  
  db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hashedPassword, resetData.userId], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Failed to reset password' });
    }
    
    resetTokens.delete(token);
    res.json({ success: true, message: 'Password reset successfully' });
  });
});

// ============= CREATE DEMO USERS =============
app.get('/api/setup-demo-users', async (req, res) => {
  const demoUsers = [
    {
      email: 'demo01@airesumerefine.com',
      name: 'Demo User Basic',
      plan: 'basic',
      max_optimizations: 10,
      password: 'demo123'
    },
    {
      email: 'demo02@airesumerefine.com',
      name: 'Demo User Advance',
      plan: 'advance',
      max_optimizations: 20,
      password: 'demo123'
    },
    {
      email: 'demo03@airesumerefine.com',
      name: 'Demo User Top',
      plan: 'top',
      max_optimizations: 30,
      password: 'demo123'
    }
  ];
  
  let results = [];
  
  for (const user of demoUsers) {
    const hashedPassword = await bcrypt.hash(user.password, 10);
    
    // Check if user already exists
    const existing = await new Promise((resolve) => {
      db.get(`SELECT id FROM users WHERE email = ?`, [user.email], (err, row) => resolve(row));
    });
    
    if (!existing) {
      await new Promise((resolve) => {
        db.run(
          `INSERT INTO users (email, name, password_hash, plan, max_optimizations, optimizations_used) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [user.email, user.name, hashedPassword, user.plan, user.max_optimizations, 0],
          (err) => resolve(err)
        );
      });
      results.push({ ...user, status: 'created' });
    } else {
      // Update existing user
      await new Promise((resolve) => {
        db.run(
          `UPDATE users SET name = ?, plan = ?, max_optimizations = ? WHERE email = ?`,
          [user.name, user.plan, user.max_optimizations, user.email],
          (err) => resolve(err)
        );
      });
      results.push({ ...user, status: 'updated' });
    }
  }
  
  res.json({
    success: true,
    message: 'Demo users created/updated successfully',
    users: results.map(u => ({
      email: u.email,
      plan: u.plan,
      optimizations: u.max_optimizations,
      password: u.password,
      status: u.status
    }))
  });
});

// TEMPORARY - Check demo users
app.get('/api/check-demo-users', (req, res) => {
  db.all(`SELECT email, plan, max_optimizations, optimizations_used FROM users WHERE email LIKE 'demo%'`, [], (err, users) => {
    if (err) {
      res.json({ error: err.message });
    } else {
      res.json({ users });
    }
  });
});

// ============= TEST MODE - SIMULATE PAYMENT SUCCESS =============
app.post('/api/test-payment-success', async (req, res) => {
    const { email, firstName, lastName, plan, maxOptimizations, features } = req.body;
    
    console.log('🎯 TEST MODE: Creating account for:', { email, plan, maxOptimizations });
    
    if (!email || !plan) {
        return res.status(400).json({ error: 'Email and plan required' });
    }
    
    try {
        // Check if user already exists
        const existingUser = await new Promise((resolve) => {
            db.get(`SELECT id FROM users WHERE email = ?`, [email], (err, row) => resolve(row));
        });
        
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists with this email' });
        }
        
        // Generate random password
        const generateRandomPassword = () => {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
            let password = '';
            for (let i = 0; i < 10; i++) {
                password += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return password;
        };
        
        const temporaryPassword = generateRandomPassword();
        const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
        const name = `${firstName || ''} ${lastName || ''}`.trim() || email.split('@')[0];
        
        // Create user
        await new Promise((resolve) => {
            db.run(
                `INSERT INTO users (email, name, password_hash, plan, max_optimizations, optimizations_used) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [email, name, hashedPassword, plan.toLowerCase(), maxOptimizations, 0],
                (err) => resolve(err)
            );
        });
        
        console.log('✅ Test user created:', email);
        console.log('📧 Temporary password:', temporaryPassword);
        
        // For testing, send back the credentials (in production, send via email)
        res.json({
            success: true,
            message: 'Account created successfully',
            credentials: {
                email: email,
                password: temporaryPassword
            }
        });
        
    } catch (error) {
        console.error('Error creating test user:', error);
        res.status(500).json({ error: 'Failed to create account' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`✅ Server Running on port ${PORT}`);
  console.log(`   Claude API: ${process.env.CLAUDE_API_KEY ? '✅ Loaded' : '❌ Missing'}`);
  console.log(`   Demo user: demo@airesumerefine.com`);
  console.log(`========================================`);
});
