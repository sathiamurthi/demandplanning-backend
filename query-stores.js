const { Client } = require('pg');

const databaseUrl = 'postgresql://neondb_owner:npg_Ty8nLXEefH7b@ep-long-wildflower-awz3odd6-pooler.c-12.us-east-1.aws.neon.tech/dplaning?sslmode=require&channel_binding=require';

async function run() {
  const client = new Client({
    connectionString: databaseUrl
  });

  try {
    await client.connect();
    console.log("Connected to PostgreSQL successfully.");

    // Query users in tenant 8577ae94-609a-4bc6-b29b-5f9cef2a6b94
    const users = await client.query(
      "SELECT id, email, role, tenant_id, store_id FROM users WHERE tenant_id = '8577ae94-609a-4bc6-b29b-5f9cef2a6b94'"
    );
    console.log("Users in Apollo Pharmacy Whitefield tenant:", JSON.stringify(users.rows, null, 2));

  } catch (err) {
    console.error("Database query failed:", err.message);
  } finally {
    await client.end();
  }
}

run();
