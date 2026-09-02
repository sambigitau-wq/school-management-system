const nodemailer = require('nodemailer');
require('dotenv').config();

console.log('📧 Testing Email Configuration...');
console.log('📧 Host:', process.env.EMAIL_HOST);
console.log('📧 Port:', process.env.EMAIL_PORT);
console.log('📧 User:', process.env.EMAIL_USER);
console.log('📧 Password:', process.env.EMAIL_PASS ? '✅ Set' : '❌ Not set');

// Create transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Test connection
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Email configuration error:', error.message);
    console.log('💡 Make sure:');
    console.log('   1. You have 2FA enabled on your Gmail account');
    console.log('   2. You created an App Password for this application');
    console.log('   3. The App Password is correct');
  } else {
    console.log('✅ Email configuration is working!');
    console.log('📧 Ready to send emails.');
  }
});

// Send a test email
console.log('\n📧 Sending test email...');
transporter.sendMail({
  from: `"SchoolAid Test" <${process.env.EMAIL_USER}>`,
  to: process.env.EMAIL_USER,
  subject: '✅ SchoolAid Test Email',
  text: 'This is a test email from SchoolAid!',
  html: '<h1>✅ SchoolAid Test Email</h1><p>This is a test email from SchoolAid!</p><p>Time: ' + new Date().toLocaleString() + '</p>'
}, (error, info) => {
  if (error) {
    console.error('❌ Failed to send test email:', error.message);
  } else {
    console.log('✅ Test email sent successfully!');
    console.log('📧 Message ID:', info.messageId);
    console.log('📧 Check your inbox at:', process.env.EMAIL_USER);
  }
});
