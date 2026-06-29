const { Client } = require('pg');

const databaseUrl = 'postgres://postgres:admin@localhost:5432/dplaning';

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
