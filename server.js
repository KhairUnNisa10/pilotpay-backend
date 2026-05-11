const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

// Allow all origins for testing (you can restrict later)
app.use(cors());
app.use(express.json());

const PILOTPAY_CONFIG = {
  apiKey: 'ppk_Zf3GX-MhrqR-nOJitVB2b2ZWvBTYjYe9z0lGsuk7CC0',
  gatewayId: 'gwy2BWTrm2zzHV',
  baseUrl: 'https://sandbox.pilotpay.io/api/v1/core',
  isSandbox: true
};

const YOUR_DOMAIN = process.env.DOMAIN_URL || 'http://airesumerefine.com/staging';

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

  const usdAmount = originalCurrency === 'EUR' ? (parseFloat(amount) * 1.17).toFixed(2) : amount;
  
  const paymentData = {
    extOrderId: String(extOrderId),
    email: email,
    description: "CV Optimization",
    tag: `order-${extOrderId}`,
    amount: usdAmount,
    currency: "USD",
    type: "fiat",
    method: "card",
    successRedirectURL: `${YOUR_DOMAIN}/payment-success?order=${extOrderId}`,
    failureRedirectURL: `${YOUR_DOMAIN}/payment`,
    additions: {
      email: email,
      card_number: cardNumber.replace(/\s/g, ''),
      card_expiry_month: expiryMonth,
      card_expiry_year: expiryYear,
      card_cvv: cvv,
      first_name: firstName,
      last_name: lastName,
      billing_country: billingAddress?.country || "US"
    }
  };

  const uniqueRequestId = crypto.randomUUID();

  try {
    const response = await axios.post(
      `${PILOTPAY_CONFIG.baseUrl}/gateway/${PILOTPAY_CONFIG.gatewayId}/payment`,
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
    
    res.json({
      success: true,
      paymentId: response.data.payment?.shortId || response.data.shortId,
      status: response.data.payment?.status || response.data.status,
      redirectUrl: response.data.link || null,
      requiresRedirect: !!response.data.link
    });
    
  } catch (error) {
    console.error('❌ PilotPay Error:', error.response?.status);
    
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
      `${PILOTPAY_CONFIG.baseUrl}/gateway/${PILOTPAY_CONFIG.gatewayId}/payment/${paymentId}`,
      { headers: { 'api-key': PILOTPAY_CONFIG.apiKey } }
    );
    
    res.json({ status: response.data.status });
  } catch (error) {
    res.status(400).json({ error: 'Failed to fetch payment status' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`✅ PilotPay Backend Running`);
  console.log(`   Port: ${PORT}`);
  console.log(`========================================`);
});
