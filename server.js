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
  
  // Add columns if needed
  db.run(`ALTER TABLE users ADD COLUMN name TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN max_optimizations INTEGER DEFAULT 10`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN optimizations_used INTEGER DEFAULT 0`, () => {});
  
  // Update existing users
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

// Add a root route for testing
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
    db.get(`SELECT id, email, name, plan, max_optimizations, optimizations_used,
                   (max_optimizations - optimizations_used) as remaining_optimizations 
            FROM users WHERE email = 'demo@airesumerefine.com'`, (err, user) => {
      if (err || !user) {
        return res.status(500).json({ error: 'Demo user not found' });
      }
      
      const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET);
      
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
    
    if (user.password_hash !== 'demo_hash') {
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
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
app.get('/api/dashboard', authenticateToken, (req, res) => {
  db.get(`SELECT id, email, name, plan, max_optimizations, optimizations_used,
                 (max_optimizations - optimizations_used) as remaining_optimizations 
          FROM users WHERE id = ?`, [req.user.userId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`✅ Server Running on port ${PORT}`);
  console.log(`   Claude API: ${process.env.CLAUDE_API_KEY ? '✅ Loaded' : '❌ Missing'}`);
  console.log(`   Demo user: demo@airesumerefine.com`);
  console.log(`========================================`);
});