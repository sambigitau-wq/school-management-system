// backend/smsService.js
const africastalking = require('africastalking');
const twilio = require('twilio');

class SMSService {
  constructor() {
    this.providers = {
      AFRICASTALKING: 'africastalking',
      CELCOM: 'celcom',
      SMSLEOPARD: 'smsleopard',
      ADVANTA: 'advanta',
      PAWATALK: 'pawatalk',
      TWILIO: 'twilio',
      BULKSMS: 'bulksms',
      SMSCOUNTRY: 'smscountry'
    };
  }

  /**
   * Send SMS using the school's configured provider
   */
  async sendBulkSMS(school, recipients, message, options = {}) {
    const provider = school.smsProvider || 'NONE';
    
    console.log(`📱 Sending ${recipients.length} SMS via ${provider}`);

    if (!school.smsConfig?.enabled) {
      return {
        success: false,
        error: 'SMS is not enabled for this school',
        sent: 0,
        failed: recipients.length,
        results: recipients.map(r => ({
          success: false,
          recipient: r.phone,
          error: 'SMS not enabled'
        }))
      };
    }

    // Route to the appropriate provider
    switch(provider) {
      case 'AFRICASTALKING':
        return await this.sendAfricaSTalking(school, recipients, message, options);
      case 'CELCOM':
        return await this.sendCelcom(school, recipients, message, options);
      case 'SMSLEOPARD':
        return await this.sendSMSLeopard(school, recipients, message, options);
      case 'ADVANTA':
        return await this.sendAdvanta(school, recipients, message, options);
      case 'PAWATALK':
        return await this.sendPawaTalk(school, recipients, message, options);
      case 'TWILIO':
        return await this.sendTwilio(school, recipients, message, options);
      case 'BULKSMS':
        return await this.sendBulkSMSProvider(school, recipients, message, options);
      case 'SMSCOUNTRY':
        return await this.sendSMSCountry(school, recipients, message, options);
      default:
        return {
          success: false,
          error: `SMS provider "${provider}" not configured`,
          sent: 0,
          failed: recipients.length,
          results: recipients.map(r => ({
            success: false,
            recipient: r.phone,
            error: 'Provider not configured'
          }))
        };
    }
  }

  /**
   * Send via Africa's Talking
   */
  async sendAfricaSTalking(school, recipients, message, options = {}) {
    try {
      const config = school.smsConfig?.africastalking || {};
      
      if (!config.apiKey || !config.username) {
        throw new Error('Africa\'s Talking credentials not configured');
      }

      const at = africastalking({
        apiKey: config.apiKey,
        username: config.username
      });

      const sms = at.SMS;
      const from = config.senderId || 'SchoolAid';
      
      // Process in batches
      const batchSize = options.batchSize || 100;
      const results = [];
      let sent = 0;
      let failed = 0;

      for (let i = 0; i < recipients.length; i += batchSize) {
        const batch = recipients.slice(i, i + batchSize);
        const numbers = batch.map(r => r.phone);
        
        try {
          const result = await sms.send({
            to: numbers,
            message: message,
            from: from
          });

          // Process results
          if (result.SMSMessageData?.Recipients) {
            result.SMSMessageData.Recipients.forEach((r, index) => {
              if (r.status === 'Success') {
                sent++;
                results.push({
                  success: true,
                  recipient: batch[index]?.phone || r.number,
                  result: r
                });
              } else {
                failed++;
                results.push({
                  success: false,
                  recipient: batch[index]?.phone || r.number,
                  error: r.status || 'Unknown error'
                });
              }
            });
          } else {
            // If no detailed results, assume all succeeded
            batch.forEach(r => {
              sent++;
              results.push({
                success: true,
                recipient: r.phone,
                result: { status: 'Success' }
              });
            });
          }

        } catch (err) {
          console.error('Batch error:', err);
          batch.forEach(r => {
            failed++;
            results.push({
              success: false,
              recipient: r.phone,
              error: err.message
            });
          });
        }

        // Delay between batches
        if (i + batchSize < recipients.length) {
          await new Promise(resolve => setTimeout(resolve, options.delayBetweenBatches || 2000));
        }
      }

      // Track usage
      await this.trackUsage(school, sent, failed);

      return {
        success: true,
        sent,
        failed,
        total: recipients.length,
        results
      };

    } catch (error) {
      console.error('❌ Africa\'s Talking error:', error);
      return {
        success: false,
        error: error.message,
        sent: 0,
        failed: recipients.length,
        results: recipients.map(r => ({
          success: false,
          recipient: r.phone,
          error: error.message
        }))
      };
    }
  }

  /**
   * Send via Celcom Africa (KES 0.25/SMS)
   */
  async sendCelcom(school, recipients, message, options = {}) {
    try {
      const config = school.smsConfig?.celcom || {};
      
      if (!config.apiKey) {
        throw new Error('Celcom API key not configured');
      }

      // Celcom uses a simple HTTP API
      const from = config.senderId || 'SchoolAid';
      const route = config.route || 'direct';
      
      const results = [];
      let sent = 0;
      let failed = 0;

      // Process each recipient individually for Celcom
      for (const recipient of recipients) {
        try {
          const response = await fetch('https://api.celcom.co.ke/sms/v1/send', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.apiKey}`
            },
            body: JSON.stringify({
              to: recipient.phone,
              from: from,
              message: message,
              route: route,
              callback: config.callbackUrl || ''
            })
          });

          const result = await response.json();

          if (result.status === 'success') {
            sent++;
            results.push({
              success: true,
              recipient: recipient.phone,
              result: result
            });
          } else {
            failed++;
            results.push({
              success: false,
              recipient: recipient.phone,
              error: result.message || 'Failed to send'
            });
          }

        } catch (err) {
          console.error('Celcom error:', err);
          failed++;
          results.push({
            success: false,
            recipient: recipient.phone,
            error: err.message
          });
        }

        // Small delay between sends
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      await this.trackUsage(school, sent, failed);

      return {
        success: true,
        sent,
        failed,
        total: recipients.length,
        results
      };

    } catch (error) {
      console.error('❌ Celcom error:', error);
      return {
        success: false,
        error: error.message,
        sent: 0,
        failed: recipients.length,
        results: recipients.map(r => ({
          success: false,
          recipient: r.phone,
          error: error.message
        }))
      };
    }
  }

  /**
   * Send via SMSLeopard (KES 0.3-0.9/SMS)
   */
  async sendSMSLeopard(school, recipients, message, options = {}) {
    try {
      const config = school.smsConfig?.smsleopard || {};
      
      if (!config.apiKey) {
        throw new Error('SMSLeopard API key not configured');
      }

      const from = config.senderId || 'SchoolAid';
      const route = config.route || 'safaricom';
      
      // Process in batches of 100
      const batchSize = 100;
      const results = [];
      let sent = 0;
      let failed = 0;

      for (let i = 0; i < recipients.length; i += batchSize) {
        const batch = recipients.slice(i, i + batchSize);
        const numbers = batch.map(r => r.phone);
        
        try {
          const response = await fetch('https://api.smsleopard.com/sms/send', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.apiKey}`
            },
            body: JSON.stringify({
              to: numbers,
              from: from,
              message: message,
              route: route,
              userId: config.userId || ''
            })
          });

          const result = await response.json();

          if (result.status === 'success') {
            // Process each number in the batch
            numbers.forEach(phone => {
              sent++;
              results.push({
                success: true,
                recipient: phone,
                result: result
              });
            });
          } else {
            numbers.forEach(phone => {
              failed++;
              results.push({
                success: false,
                recipient: phone,
                error: result.message || 'Failed to send'
              });
            });
          }

        } catch (err) {
          console.error('SMSLeopard error:', err);
          batch.forEach(r => {
            failed++;
            results.push({
              success: false,
              recipient: r.phone,
              error: err.message
            });
          });
        }

        // Delay between batches
        if (i + batchSize < recipients.length) {
          await new Promise(resolve => setTimeout(resolve, options.delayBetweenBatches || 2000));
        }
      }

      await this.trackUsage(school, sent, failed);

      return {
        success: true,
        sent,
        failed,
        total: recipients.length,
        results
      };

    } catch (error) {
      console.error('❌ SMSLeopard error:', error);
      return {
        success: false,
        error: error.message,
        sent: 0,
        failed: recipients.length,
        results: recipients.map(r => ({
          success: false,
          recipient: r.phone,
          error: error.message
        }))
      };
    }
  }

  /**
   * Send via Advanta Africa (KES 0.30-0.80/SMS)
   */
  async sendAdvanta(school, recipients, message, options = {}) {
    try {
      const config = school.smsConfig?.advanta || {};
      
      if (!config.apiKey || !config.username) {
        throw new Error('Advanta credentials not configured');
      }

      const from = config.senderId || 'SchoolAid';
      
      const results = [];
      let sent = 0;
      let failed = 0;

      for (const recipient of recipients) {
        try {
          const response = await fetch('https://api.advanta.co.ke/api/sms/v1/send', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.apiKey}`
            },
            body: JSON.stringify({
              to: recipient.phone,
              from: from,
              message: message,
              username: config.username,
              partnerId: config.partnerId || ''
            })
          });

          const result = await response.json();

          if (result.status === 'success') {
            sent++;
            results.push({
              success: true,
              recipient: recipient.phone,
              result: result
            });
          } else {
            failed++;
            results.push({
              success: false,
              recipient: recipient.phone,
              error: result.message || 'Failed to send'
            });
          }

        } catch (err) {
          console.error('Advanta error:', err);
          failed++;
          results.push({
            success: false,
            recipient: recipient.phone,
            error: err.message
          });
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      }

      await this.trackUsage(school, sent, failed);

      return {
        success: true,
        sent,
        failed,
        total: recipients.length,
        results
      };

    } catch (error) {
      console.error('❌ Advanta error:', error);
      return {
        success: false,
        error: error.message,
        sent: 0,
        failed: recipients.length,
        results: recipients.map(r => ({
          success: false,
          recipient: r.phone,
          error: error.message
        }))
      };
    }
  }

  /**
   * Send via PawaTalk (Payment + SMS)
   */
  async sendPawaTalk(school, recipients, message, options = {}) {
    try {
      const config = school.smsConfig?.pawatalk || {};
      
      if (!config.apiKey || !config.merchantId) {
        throw new Error('PawaTalk credentials not configured');
      }

      const from = config.senderId || 'SchoolAid';
      
      const results = [];
      let sent = 0;
      let failed = 0;

      for (const recipient of recipients) {
        try {
          const response = await fetch('https://api.pawatalk.co.ke/v1/sms/send', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.apiKey}`
            },
            body: JSON.stringify({
              to: recipient.phone,
              from: from,
              message: message,
              merchantId: config.merchantId,
              callback: config.callbackUrl || ''
            })
          });

          const result = await response.json();

          if (result.status === 'success') {
            sent++;
            results.push({
              success: true,
              recipient: recipient.phone,
              result: result
            });
          } else {
            failed++;
            results.push({
              success: false,
              recipient: recipient.phone,
              error: result.message || 'Failed to send'
            });
          }

        } catch (err) {
          console.error('PawaTalk error:', err);
          failed++;
          results.push({
            success: false,
            recipient: recipient.phone,
            error: err.message
          });
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      }

      await this.trackUsage(school, sent, failed);

      return {
        success: true,
        sent,
        failed,
        total: recipients.length,
        results
      };

    } catch (error) {
      console.error('❌ PawaTalk error:', error);
      return {
        success: false,
        error: error.message,
        sent: 0,
        failed: recipients.length,
        results: recipients.map(r => ({
          success: false,
          recipient: r.phone,
          error: error.message
        }))
      };
    }
  }

  /**
   * Send via Twilio
   */
  async sendTwilio(school, recipients, message, options = {}) {
    try {
      const config = school.smsConfig?.twilio || {};
      
      if (!config.accountSid || !config.authToken) {
        throw new Error('Twilio credentials not configured');
      }

      const client = twilio(config.accountSid, config.authToken);
      const from = config.fromNumber;

      const results = [];
      let sent = 0;
      let failed = 0;

      for (const recipient of recipients) {
        try {
          const result = await client.messages.create({
            body: message,
            from: from,
            to: recipient.phone
          });

          sent++;
          results.push({
            success: true,
            recipient: recipient.phone,
            result: result
          });

        } catch (err) {
          console.error('Twilio error:', err);
          failed++;
          results.push({
            success: false,
            recipient: recipient.phone,
            error: err.message
          });
        }
      }

      await this.trackUsage(school, sent, failed);

      return {
        success: true,
        sent,
        failed,
        total: recipients.length,
        results
      };

    } catch (error) {
      console.error('❌ Twilio error:', error);
      return {
        success: false,
        error: error.message,
        sent: 0,
        failed: recipients.length,
        results: recipients.map(r => ({
          success: false,
          recipient: r.phone,
          error: error.message
        }))
      };
    }
  }

  /**
   * Send via BulkSMS
   */
  async sendBulkSMSProvider(school, recipients, message, options = {}) {
    try {
      const config = school.smsConfig?.bulksms || {};
      
      if (!config.username || !config.password) {
        throw new Error('BulkSMS credentials not configured');
      }

      const from = config.from || 'SchoolAid';
      
      const results = [];
      let sent = 0;
      let failed = 0;

      for (const recipient of recipients) {
        try {
          const response = await fetch('https://api.bulksms.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`
            },
            body: JSON.stringify({
              to: recipient.phone,
              from: from,
              body: message
            })
          });

          const result = await response.json();

          if (result.status === 'success') {
            sent++;
            results.push({
              success: true,
              recipient: recipient.phone,
              result: result
            });
          } else {
            failed++;
            results.push({
              success: false,
              recipient: recipient.phone,
              error: result.message || 'Failed to send'
            });
          }

        } catch (err) {
          console.error('BulkSMS error:', err);
          failed++;
          results.push({
            success: false,
            recipient: recipient.phone,
            error: err.message
          });
        }
      }

      await this.trackUsage(school, sent, failed);

      return {
        success: true,
        sent,
        failed,
        total: recipients.length,
        results
      };

    } catch (error) {
      console.error('❌ BulkSMS error:', error);
      return {
        success: false,
        error: error.message,
        sent: 0,
        failed: recipients.length,
        results: recipients.map(r => ({
          success: false,
          recipient: r.phone,
          error: error.message
        }))
      };
    }
  }

  /**
   * Send via SMS Country
   */
  async sendSMSCountry(school, recipients, message, options = {}) {
    try {
      const config = school.smsConfig?.smscountry || {};
      
      if (!config.username || !config.password) {
        throw new Error('SMS Country credentials not configured');
      }

      const from = config.senderId || 'SchoolAid';
      const route = config.route || 'default';
      
      const results = [];
      let sent = 0;
      let failed = 0;

      for (const recipient of recipients) {
        try {
          const response = await fetch('https://api.smscountry.com/v1/sendsms', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              to: recipient.phone,
              from: from,
              message: message,
              username: config.username,
              password: config.password,
              route: route
            })
          });

          const result = await response.json();

          if (result.status === 'success') {
            sent++;
            results.push({
              success: true,
              recipient: recipient.phone,
              result: result
            });
          } else {
            failed++;
            results.push({
              success: false,
              recipient: recipient.phone,
              error: result.message || 'Failed to send'
            });
          }

        } catch (err) {
          console.error('SMS Country error:', err);
          failed++;
          results.push({
            success: false,
            recipient: recipient.phone,
            error: err.message
          });
        }
      }

      await this.trackUsage(school, sent, failed);

      return {
        success: true,
        sent,
        failed,
        total: recipients.length,
        results
      };

    } catch (error) {
      console.error('❌ SMS Country error:', error);
      return {
        success: false,
        error: error.message,
        sent: 0,
        failed: recipients.length,
        results: recipients.map(r => ({
          success: false,
          recipient: r.phone,
          error: error.message
        }))
      };
    }
  }

  /**
   * Track SMS usage for the school
   */
  async trackUsage(school, sent, failed) {
    try {
      // Update school's SMS usage
      const usage = school.smsUsage || {};
      const totalSent = (usage.totalSent || 0) + sent;
      const totalFailed = (usage.failedCount || 0) + failed;
      
      // Update monthly usage
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const monthlyUsage = usage.monthlyUsage || {};
      monthlyUsage[monthKey] = (monthlyUsage[monthKey] || 0) + sent;
      
      // Update daily usage
      const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const dailyUsage = usage.dailyUsage || {};
      dailyUsage[dayKey] = (dailyUsage[dayKey] || 0) + sent;

      // Calculate cost
      const costPerSMS = school.getSMSCost ? school.getSMSCost() : 0.50;
      const totalCost = (usage.totalCost || 0) + (sent * costPerSMS);

      await school.update({
        smsUsage: {
          totalSent,
          totalCost,
          monthlyUsage,
          dailyUsage,
          failedCount: totalFailed,
          lastReset: new Date(),
          monthlyLimit: usage.monthlyLimit || 5000
        }
      });

    } catch (error) {
      console.error('❌ Error tracking SMS usage:', error);
    }
  }

  /**
   * Clean phone number to international format
   */
  cleanPhoneNumber(phone, defaultCountryCode = '254') {
    if (!phone) return null;
    let cleaned = phone.replace(/[^0-9+]/g, '');
    
    if (!cleaned.startsWith('+')) {
      if (cleaned.startsWith('0')) {
        cleaned = cleaned.substring(1);
      }
      cleaned = `+${defaultCountryCode}${cleaned}`;
    }
    
    return cleaned;
  }

  /**
   * Validate phone number
   */
  validatePhoneNumber(phone) {
    if (!phone) return false;
    const cleaned = this.cleanPhoneNumber(phone);
    return cleaned && cleaned.length >= 10 && cleaned.length <= 15;
  }

  /**
   * Test SMS configuration
   */
  async testConfiguration(school, testPhone) {
    try {
      const provider = school.smsProvider || 'NONE';
      
      if (!school.isSMSEnabled()) {
        return {
          success: false,
          message: 'SMS is not enabled for this school',
          provider
        };
      }

      const cleanedPhone = this.cleanPhoneNumber(
        testPhone,
        school.smsConfig?.defaultCountryCode || '254'
      );

      if (!this.validatePhoneNumber(cleanedPhone)) {
        return {
          success: false,
          message: 'Invalid phone number format',
          provider
        };
      }

      const message = `🔧 SMS Test from ${school.name || 'SchoolAid'}\n\nIf you received this, your SMS is working!`;
      
      const result = await this.sendBulkSMS(
        school,
        [{ phone: cleanedPhone, name: 'Test' }],
        message,
        { testMode: true }
      );

      return {
        success: result.success && result.sent > 0,
        message: result.success && result.sent > 0 
          ? '✅ Test SMS sent successfully!' 
          : `❌ Failed: ${result.error || 'No SMS sent'}`,
        provider,
        details: result
      };

    } catch (error) {
      console.error('❌ Test SMS error:', error);
      return {
        success: false,
        message: `❌ Test failed: ${error.message}`,
        provider: school?.smsProvider || 'NONE'
      };
    }
  }
}

module.exports = new SMSService();