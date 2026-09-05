const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
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

async function createAdmin() {
  try {
    await client.connect();
    console.log('✅ Connected to database');
    
    const email = 'sambigitau@gmail.com';
    const password = 'SAMBIWILLMAKEIT';
    const firstName = 'Sambi';
    const lastName = 'Gitau';
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Check if user already exists
    const checkUser = await client.query(
      'SELECT email FROM "Users" WHERE email = $1',
      [email]
    );
    
    if (checkUser.rows.length > 0) {
      console.log('⚠️ User already exists!');
      console.log('📧 Email:', email);
      console.log('🔑 Password: SAMBIWILLMAKEIT');
      console.log('💡 Try logging in directly.');
      await client.end();
      return;
    }
    
    // First, let's check what roles are valid
    const rolesResult = await client.query(
      "SELECT enum_range(NULL::\"enum_Users_role\");"
    );
    console.log('📋 Available roles:', rolesResult.rows[0].enum_range);
    
    // Try with 'SUPER_ADMIN' instead of 'ADMIN'
    const result = await client.query(
      `INSERT INTO "Users" (
        id, email, password, "firstName", "lastName", role, "isActive", "createdAt", "updatedAt"
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING id, email, role, "firstName", "lastName"`,
      [uuidv4(), email, hashedPassword, firstName, lastName, 'SUPER_ADMIN', true]
    );
    
    console.log('✅ Super Admin created successfully!');
    console.log('📧 Email:', result.rows[0].email);
    console.log('🔑 Password: SAMBIWILLMAKEIT');
    console.log('👤 Name:', result.rows[0].firstName, result.rows[0].lastName);
    console.log('🎯 Role:', result.rows[0].role);
    console.log('🆔 ID:', result.rows[0].id);
    console.log('');
    console.log('🌐 Login at: https://schoolaid.zyphra.co.ke');
    console.log('   or: https://school-management-system-xi-brown.vercel.app');
    
    await client.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.message.includes('duplicate key')) {
      console.log('⚠️ This email already exists in the database.');
      console.log('💡 Try logging in with sambigitau@gmail.com');
    } else if (error.message.includes('invalid input value for enum')) {
      console.log('⚠️ The role value is invalid.');
      console.log('💡 Trying without role column...');
      
      // Try without role
      try {
        const result2 = await client.query(
          `INSERT INTO "Users" (
            id, email, password, "firstName", "lastName", "isActive", "createdAt", "updatedAt"
           )
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
           RETURNING id, email, "firstName", "lastName"`,
          [uuidv4(), email, hashedPassword, firstName, lastName, true]
        );
        console.log('✅ User created without role!');
        console.log('📧 Email:', result2.rows[0].email);
        console.log('🔑 Password: SAMBIWILLMAKEIT');
        console.log('👤 Name:', result2.rows[0].firstName, result2.rows[0].lastName);
        console.log('🆔 ID:', result2.rows[0].id);
        console.log('');
        console.log('💡 Note: Role was not set. You may need to set it manually.');
        console.log('🌐 Login at: https://schoolaid.zyphra.co.ke');
      } catch (err2) {
        console.error('❌ Error without role:', err2.message);
      }
    }
    await client.end();
  }
}

createAdmin();
