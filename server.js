const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// SANDBOX CONFIGURATION - For testing on live domain
const PILOTPAY_CONFIG = {
  apiKey: 'ppk_Zf3GX-MhrqR-nOJitVB2b2ZWvBTYjYe9z0lGsuk7CC0', // Keep sandbox key for testing
  baseUrl: 'https://sandbox.pilotpay.io/api/v1/core', // Keep sandbox URL
  isSandbox: true
};

// YOUR LIVE DOMAIN (no /staging, but still testing sandbox)
const YOUR_DOMAIN = process.env.DOMAIN_URL || 'https://airesumerefine.com';

app.post('/api/create-payment', async (req, res) => {
  console.log('Received Direct API request (SANDBOX MODE):', req.body);
  
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

  // Convert to USD if needed (using fixed rate for sandbox)
  const usdAmount = originalCurrency === 'EUR' ? (parseFloat(amount) * 1.17).toFixed(2) : amount;
  
  const paymentData = {
    returnUrl: `${YOUR_DOMAIN}/payment-success?order=${extOrderId}`,
    extOrderId: String(extOrderId),
    email: email,
    description: "CV Optimization",
    tag: `order-${extOrderId}`,
    amount: usdAmount,
    currency: "USD",
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

    console.log('✅ PilotPay Sandbox Success:', response.status);
    console.log('Response:', JSON.stringify(response.data, null, 2));
    
    // Extract redirect URL from the response
    let redirectUrl = null;
    if (response.data.context?.paymentDetails?.url) {
      redirectUrl = response.data.context.paymentDetails.url;
    } else if (response.data.context?.redirectUrl) {
      redirectUrl = response.data.context.redirectUrl;
    } else if (response.data.redirectUrl) {
      redirectUrl = response.data.redirectUrl;
    }
    
    if (redirectUrl) {
      // 3DS redirect required
      res.json({
        success: true,
        requiresRedirect: true,
        redirectUrl: redirectUrl,
        paymentId: response.data.shortId
      });
    } else if (response.data.status === 'SUCCESS') {
      // Payment completed immediately
      res.json({
        success: true,
        status: 'SUCCESS',
        paymentId: response.data.shortId
      });
    } else {
      // Payment is processing - poll for status
      res.json({
        success: true,
        paymentId: response.data.shortId,
        status: response.data.status,
        requiresPolling: true
      });
    }
    
  } catch (error) {
    console.error('❌ PilotPay Sandbox Error:', error.response?.status);
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`✅ PilotPay Backend Running (SANDBOX MODE - Testing on Live Domain)`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Environment: SANDBOX (testing only - no real charges)`);
  console.log(`   Domain: ${YOUR_DOMAIN}`);
  console.log(`   API URL: ${PILOTPAY_CONFIG.baseUrl}/payment`);
  console.log(`   ⚠️  Using test card numbers only!`);
  console.log(`========================================`);
});
