const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// SANDBOX CONFIGURATION - For testing on live domain
const PILOTPAY_CONFIG = {
  apiKey: 'ppk_Zf3GX-MhrqR-nOJitVB2b2ZWvBTYjYe9z0lGsuk7CC0',
  baseUrl: 'https://sandbox.pilotpay.io/api/v1/core',
  isSandbox: true
};

// YOUR LIVE DOMAIN
const YOUR_DOMAIN = process.env.DOMAIN_URL || 'https://airesumerefine.com';

app.post('/api/create-payment', async (req, res) => {
  console.log('Received Direct API request:', req.body);
  
  const {
    extOrderId,
    email,
    amount,
    currency: originalCurrency,  // This is the selected currency from packages page
    cardNumber,
    expiryMonth,
    expiryYear,
    cvv,
    firstName,
    lastName,
    billingAddress
  } = req.body;

  // ONLY convert to USD if the currency is NOT already USD
  let finalAmount = amount;
  let finalCurrency = originalCurrency;
  let conversionApplied = false;

  if (originalCurrency === 'USD') {
    // No conversion needed - keep as is
    finalAmount = amount;
    finalCurrency = 'USD';
    conversionApplied = false;
    console.log('💰 Currency is already USD - no conversion applied');
  } else if (originalCurrency === 'EUR') {
    // Convert EUR to USD
    finalAmount = (parseFloat(amount) * 1.17).toFixed(2);
    finalCurrency = 'USD';
    conversionApplied = true;
    console.log(`🔄 Converted EUR ${amount} to USD ${finalAmount} (rate: 1.17)`);
  } else if (originalCurrency === 'GBP') {
    // Convert GBP to USD (1 GBP = 1.27 USD)
    finalAmount = (parseFloat(amount) * 1.27).toFixed(2);
    finalCurrency = 'USD';
    conversionApplied = true;
    console.log(`🔄 Converted GBP ${amount} to USD ${finalAmount} (rate: 1.27)`);
  } else if (originalCurrency === 'CAD') {
    // Convert CAD to USD (1 CAD = 0.73 USD)
    finalAmount = (parseFloat(amount) * 0.73).toFixed(2);
    finalCurrency = 'USD';
    conversionApplied = true;
    console.log(`🔄 Converted CAD ${amount} to USD ${finalAmount} (rate: 0.73)`);
  } else if (originalCurrency === 'AUD') {
    // Convert AUD to USD (1 AUD = 0.66 USD)
    finalAmount = (parseFloat(amount) * 0.66).toFixed(2);
    finalCurrency = 'USD';
    conversionApplied = true;
    console.log(`🔄 Converted AUD ${amount} to USD ${finalAmount} (rate: 0.66)`);
  } else {
    // Unknown currency - default to USD with conversion
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
    currency: finalCurrency,  // Always send USD to PilotPay
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
    console.log('Payment Info:', {
      original_currency: originalCurrency,
      original_amount: amount,
      sent_currency: finalCurrency,
      sent_amount: finalAmount,
      conversion_applied: conversionApplied
    });
    
    // Extract redirect URL
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`✅ PilotPay Backend Running`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Environment: ${PILOTPAY_CONFIG.isSandbox ? 'SANDBOX' : 'PRODUCTION'}`);
  console.log(`   Domain: ${YOUR_DOMAIN}`);
  console.log(`   Currency Conversion: Enabled (EUR/GBP/CAD/AUD → USD, USD stays USD)`);
  console.log(`========================================`);
});
