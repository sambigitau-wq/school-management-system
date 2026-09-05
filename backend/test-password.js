const bcrypt = require('bcrypt');
const { Client } = require('pg');

const client = new Client({
  host: 'dpg-dac1o4e7bikc73ekh8lg-a.oregon-postgres.render.com',
  port: 5432,
  database: 'schoolaid_saas',
  user: 'schoolaid_saas_user',
  password: 'mNYTxZcTt6ljyGOVIaUZNjXjJ7nqtBT3',
  ssl: {
    rejectUnauthorized: false
  }
});

async function testPassword() {
  try {
    await client.connect();
    console.log('✅ Connected to database');
    
    const email = 'sambigitau@gmail.com';
    const testPassword = 'SAMBIWILLMAKEIT';
    
    // Get user from database
    const result = await client.query(
      'SELECT id, email, password, role, "isActive" FROM "Users" WHERE email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      console.log('❌ User not found!');
      await client.end();
      return;
    }
    
    const user = result.rows[0];
    console.log('📧 User found:', user.email);
    console.log('🎯 Role:', user.role);
    console.log('✅ Active:', user.isActive);
    console.log('🔑 Hashed password in DB:', user.password);
    console.log('📝 Password to test:', testPassword);
    
    // Test the password
    const isValid = await bcrypt.compare(testPassword, user.password);
    console.log('');
    console.log('🔍 Password match:', isValid ? '✅ YES' : '❌ NO');
    
    if (!isValid) {
      console.log('');
      console.log('⚠️ Password does not match!');
      console.log('💡 I will reset the password now...');
      
      // Reset password
      const newHashedPassword = await bcrypt.hash(testPassword, 10);
      
      await client.query(
        'UPDATE "Users" SET password = $1 WHERE email = $2',
        [newHashedPassword, email]
      );
      
      console.log('✅ Password has been reset!');
      console.log('📧 Email:', email);
      console.log('🔑 New Password:', testPassword);
      console.log('');
      console.log('🌐 Try logging in now at: https://schoolaid.zyphra.co.ke');
    } else {
      console.log('');
      console.log('✅ Password is correct! The issue might be in the login code.');
      console.log('💡 Check your backend server.cjs login endpoint.');
    }
    
    await client.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    await client.end();
  }
}

testPassword();
