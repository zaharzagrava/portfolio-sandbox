// generate-token.js
const jwt = require('jsonwebtoken');
const fs = require('fs');

// Grab the user ID from the command line arguments
const userId = process.argv[2];

if (!userId) {
  console.error('❌ Error: Please provide a userId.');
  console.log('Usage: node generate-token.js <your-uuid-here>');
  process.exit(1);
}

try {
  // Read the private key we generated in the previous step
  const privateKey = fs.readFileSync('./backend/creds/jwtRS256.key', 'utf8');

  // The payload. We use 'sub' (subject) because that is the industry standard 
  // for User IDs in JWTs, and your Cloudflare Worker is looking for it.
  const payload = {
    sub: userId,
    // You can inject test roles or other data here if needed
    // role: 'admin' 
  };

  // Sign the token
  const token = jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    expiresIn: '7d' // Exactly 7 days expiration
  });

  console.log('✅ Token generated successfully!\n');
  console.log('User ID:', userId);
  console.log('Expires: In 7 days\n');
  console.log('🎟️  Your Bearer Token:');
  console.log(token);
  console.log('\nUse this in your Postman/Insomnia headers:');
  console.log(`Authorization: Bearer ${token}`);

} catch (err) {
  console.error('❌ Error:', err.message);
  console.log('Make sure "jwtRS256.key" is in the same folder and you have run: npm install jsonwebtoken');
}
