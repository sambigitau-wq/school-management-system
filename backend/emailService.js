// backend/emailService.js
const nodemailer = require('nodemailer');
const sgMail = require('@sendgrid/mail');
const { Resend } = require('resend');
const Mailgun = require('mailgun.js');
const formData = require('form-data');
const AWS = require('aws-sdk');

class EmailService {
  constructor() {
    this.providers = {
      SMTP: 'smtp',
      SENDGRID: 'sendgrid',
      RESEND: 'resend',
      MAILGUN: 'mailgun',
      AWS_SES: 'ses'
    };
  }

  /**
   * Get transporter based on school configuration
   */
  async getTransporter(schoolConfig) {
    const provider = schoolConfig?.emailProvider || 'SMTP';
    const config = schoolConfig?.emailConfig || {};

    console.log(`📧 Using email provider: ${provider}`);

    switch(provider) {
      case 'SENDGRID':
        return this.getSendGridTransporter(config);
      case 'RESEND':
        return this.getResendTransporter(config);
      case 'MAILGUN':
        return this.getMailgunTransporter(config);
      case 'AWS_SES':
        return this.getSESTransporter(config);
      case 'SMTP':
      default:
        return this.getSMTPTransporter(config);
    }
  }

  /**
   * SMTP Transporter (Gmail, Outlook, etc.)
   */
  getSMTPTransporter(config) {
    // Support both old and new config structure
    const smtpConfig = config.smtp || config;
    
    return nodemailer.createTransport({
      host: smtpConfig.host || process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: smtpConfig.port || parseInt(process.env.EMAIL_PORT) || 587,
      secure: smtpConfig.secure || smtpConfig.port === 465,
      auth: {
        user: smtpConfig.username || process.env.EMAIL_USER,
        pass: smtpConfig.password || process.env.EMAIL_PASS
      },
      tls: {
        rejectUnauthorized: false
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100
    });
  }

  /**
   * SendGrid Transporter
   */
  getSendGridTransporter(config) {
    const sendgridConfig = config.sendgrid || config;
    const apiKey = sendgridConfig.apiKey || process.env.SENDGRID_API_KEY;
    
    if (!apiKey) {
      throw new Error('SendGrid API key is required');
    }
    
    sgMail.setApiKey(apiKey);
    
    return {
      send: async (options) => {
        const fromEmail = sendgridConfig.fromEmail || process.env.EMAIL_FROM || 'noreply@schoolaid.com';
        const msg = {
          to: options.to,
          from: fromEmail,
          subject: options.subject,
          text: options.text,
          html: options.html,
          cc: options.cc,
          bcc: options.bcc,
          replyTo: sendgridConfig.replyTo || options.replyTo
        };
        return await sgMail.send(msg);
      }
    };
  }

  /**
   * Resend Transporter
   */
  getResendTransporter(config) {
    const resendConfig = config.resend || config;
    const apiKey = resendConfig.apiKey || process.env.RESEND_API_KEY;
    
    if (!apiKey) {
      throw new Error('Resend API key is required');
    }
    
    const resend = new Resend(apiKey);
    
    return {
      send: async (options) => {
        const fromEmail = resendConfig.fromEmail || process.env.EMAIL_FROM || 'noreply@schoolaid.com';
        return await resend.emails.send({
          from: fromEmail,
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html,
          cc: options.cc,
          bcc: options.bcc,
          replyTo: resendConfig.replyTo || options.replyTo
        });
      }
    };
  }

  /**
   * Mailgun Transporter
   */
  getMailgunTransporter(config) {
    const mailgunConfig = config.mailgun || config;
    const apiKey = mailgunConfig.apiKey || process.env.MAILGUN_API_KEY;
    const domain = mailgunConfig.domain || process.env.MAILGUN_DOMAIN;
    
    if (!apiKey || !domain) {
      throw new Error('Mailgun API key and domain are required');
    }
    
    const mailgun = new Mailgun(formData);
    const mg = mailgun.client({
      username: 'api',
      key: apiKey,
      url: mailgunConfig.apiUrl || process.env.MAILGUN_API_URL || 'https://api.mailgun.net'
    });

    return {
      send: async (options) => {
        const fromEmail = mailgunConfig.fromEmail || process.env.EMAIL_FROM || 'noreply@schoolaid.com';
        return await mg.messages.create(domain, {
          from: fromEmail,
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html,
          cc: options.cc,
          bcc: options.bcc,
          'h:Reply-To': mailgunConfig.replyTo || options.replyTo
        });
      }
    };
  }

  /**
   * AWS SES Transporter
   */
  getSESTransporter(config) {
    const sesConfig = config.ses || config;
    
    AWS.config.update({
      region: sesConfig.region || process.env.AWS_REGION || 'us-east-1',
      accessKeyId: sesConfig.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: sesConfig.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY
    });

    const ses = new AWS.SES({ apiVersion: '2010-12-01' });

    return {
      send: async (options) => {
        const fromEmail = sesConfig.fromEmail || process.env.EMAIL_FROM || 'noreply@schoolaid.com';
        
        const params = {
          Destination: {
            ToAddresses: Array.isArray(options.to) ? options.to : [options.to],
            CcAddresses: options.cc ? (Array.isArray(options.cc) ? options.cc : [options.cc]) : [],
            BccAddresses: options.bcc ? (Array.isArray(options.bcc) ? options.bcc : [options.bcc]) : []
          },
          Message: {
            Body: {
              Html: {
                Charset: 'UTF-8',
                Data: options.html || options.text
              },
              Text: {
                Charset: 'UTF-8',
                Data: options.text || options.html?.replace(/<[^>]*>/g, '') || ''
              }
            },
            Subject: {
              Charset: 'UTF-8',
              Data: options.subject
            }
          },
          Source: fromEmail,
          ReplyToAddresses: options.replyTo ? [options.replyTo] : []
        };

        return await ses.sendEmail(params).promise();
      }
    };
  }

// In emailService.js - Find the sendEmail method and update it

async sendEmail(school, to, subject, content, options = {}) {
  try {
    // Get school configuration
    const schoolConfig = school?.emailConfig || {};
    const provider = school?.emailProvider || 'SMTP';
    
    // ✅ Get the school name - FIX THIS
    const schoolName = school?.name || 'School';  // This should be "Conquerors Academy"
    
    console.log(`📧 Sending email from: ${schoolName}`);

    const transporter = this.getSMTPTransporter(schoolConfig);

    // Get from email
    const fromEmail = schoolConfig.fromEmail || 
                      schoolConfig.smtp?.fromEmail || 
                      process.env.EMAIL_USER || 
                      'noreply@schoolaid.com';

    // ✅ Use school name in the "From" field - THIS IS THE KEY FIX
    const emailOptions = {
      from: `"${schoolName}" <${fromEmail}>`,  // ← This makes it show "Conquerors Academy" <sambigitau33@gmail.com>
      to: to,
      subject: subject || 'No Subject',
      text: content || '',
      html: content ? content.replace(/\n/g, '<br>') : '',
      ...options
    };

    console.log(`📧 From: ${emailOptions.from}`);
    console.log(`📧 To: ${emailOptions.to}`);
    console.log(`📧 Subject: ${emailOptions.subject}`);

    const result = await transporter.sendMail(emailOptions);
    console.log(`✅ Email sent: ${result.messageId}`);
    return { success: true, result, provider, school: schoolName };

  } catch (error) {
    console.error(`❌ Email error:`, error.message);
    return { success: false, error: error.message };
  }
}
  /**
   * Send bulk emails with rate limiting
   */
  async sendBulkEmails(school, recipients, subject, content, options = {}) {
    const results = [];
    const batchSize = options.batchSize || 50;
    const delayBetweenBatches = options.delayBetweenBatches || 1000;
    const maxRetries = options.retryAttempts || 3;
    const retryDelay = options.retryDelay || 5000;

    console.log(`📧 Sending ${recipients.length} emails in batches of ${batchSize}`);

    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = recipients.slice(i, i + batchSize);
      
      const batchResults = await Promise.all(
        batch.map(async (recipient) => {
          const personalizedContent = content
            .replace(/{name}/g, recipient.name || 'User')
            .replace(/{email}/g, recipient.email || '')
            .replace(/{school}/g, school?.name || 'School')
            .replace(/{date}/g, new Date().toLocaleDateString());

          // Retry logic
          let lastError = null;
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              const result = await this.sendEmail(
                school,
                recipient.email,
                subject,
                personalizedContent,
                { ...options, to: recipient.email }
              );
              
              if (result.success) {
                return { ...result, recipient: recipient.email, name: recipient.name };
              }
              
              lastError = result.error;
              
              // If not the last attempt, wait before retrying
              if (attempt < maxRetries) {
                console.log(`🔄 Retrying ${recipient.email} (attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
              }
            } catch (err) {
              lastError = err.message;
              if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
              }
            }
          }
          
          return { 
            success: false, 
            error: lastError || 'Max retries exceeded',
            recipient: recipient.email,
            name: recipient.name
          };
        })
      );

      results.push(...batchResults);

      // Delay between batches to avoid rate limiting
      if (i + batchSize < recipients.length) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }

    const sent = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return {
      success: true,
      sent,
      failed,
      total: recipients.length,
      results
    };
  }

  /**
   * Test email configuration
   */
 // In emailService.js - Update testConfiguration
async testConfiguration(school, testEmail) {
  try {
    // Get the school name properly
    const schoolName = school?.name || school?.School?.name || 'Your School';
    const provider = school?.emailProvider || 'SMTP';
    const fromEmail = school?.emailConfig?.fromEmail || 
                      school?.emailConfig?.smtp?.fromEmail || 
                      process.env.EMAIL_USER || 
                      'noreply@schoolaid.com';
    
    console.log(`🧪 Testing email for: ${schoolName}`);
    console.log(`📧 From: ${fromEmail}`);
    console.log(`📧 Provider: ${provider}`);

    const result = await this.sendEmail(
      school,
      testEmail,
      `🔧 ${schoolName} - Email Configuration Test`,
      `This is a test email from ${schoolName}.\n\n` +
      `School: ${schoolName}\n` +
      `Provider: ${provider}\n` +
      `From Email: ${fromEmail}\n` +
      `Time: ${new Date().toLocaleString()}\n\n` +
      `If you received this, your email configuration is working correctly!`
    );

    return {
      success: result.success,
      message: result.success ? '✅ Test email sent successfully!' : `❌ Failed: ${result.error}`,
      provider: provider,
      details: result.success ? {
        sentTo: testEmail,
        school: schoolName,
        provider: provider,
        fromEmail: fromEmail,
        timestamp: new Date().toISOString()
      } : {
        error: result.error,
        school: schoolName,
        provider: provider,
        timestamp: new Date().toISOString()
      }
    };
  } catch (error) {
    console.error('❌ Test configuration error:', error);
    return {
      success: false,
      message: `❌ Test failed: ${error.message}`,
      provider: school?.emailProvider || 'SMTP'
    };
  }
}
 }

module.exports = new EmailService();