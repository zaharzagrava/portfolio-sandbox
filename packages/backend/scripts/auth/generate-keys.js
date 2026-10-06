// generate-keys.js
const crypto = require('crypto');
const fs = require('fs');

console.log('Generating RSA 2048-bit key pair...');

// Generate the key pair synchronously
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048, // 2048 is standard for JWTs. Use 4096 if you want extreme security.
  publicKeyEncoding: {
    type: 'spki',       // Recommended format for public keys
    format: 'pem'       // Base64 text format
  },
  privateKeyEncoding: {
    type: 'pkcs8',      // Recommended format for private keys
    format: 'pem'
  }
});

// Write keys to files
fs.mkdirSync('./backend/creds', { recursive: true });

fs.writeFileSync('./backend/creds/jwtRS256.key', privateKey);
fs.writeFileSync('./backend/creds/jwtRS256.key.pub', publicKey);

console.log('✅ Keys generated successfully!');
console.log('--------------------------------------------------');
console.log('1. Keep "jwtRS256.key" SECRET. Your Auth service uses this to sign the JWT.');
console.log('2. Put the contents of "jwtRS256.key.pub" into your Cloudflare Worker env.CLIENT_PUBLIC_KEY.');
console.log('--------------------------------------------------');
