const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function main() {
  let DANBOORU_LOGIN = process.env.DANBOORU_LOGIN;
  let DANBOORU_API_KEY = process.env.DANBOORU_API_KEY;

  if (!DANBOORU_LOGIN) {
    DANBOORU_LOGIN = await prompt('Enter DANBOORU_LOGIN: ');
  }
  if (!DANBOORU_API_KEY) {
    DANBOORU_API_KEY = await prompt('Enter DANBOORU_API_KEY: ');
  }

  const REDIS_PASSWORD = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  const API_SECRET = crypto.randomBytes(32).toString('hex'); // 64 hex chars
  const ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex'); // 64 hex chars for AES-256

  const secretsDir = path.join(__dirname, '..', 'secrets');
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(secretsDir, 'redis_password.txt'), REDIS_PASSWORD);

  // Output for capture in bash
  process.stdout.write(`export DANBOORU_LOGIN="${DANBOORU_LOGIN}"\n`);
  process.stdout.write(`export DANBOORU_API_KEY="${DANBOORU_API_KEY}"\n`);
  process.stdout.write(`export REDIS_PASSWORD="${REDIS_PASSWORD}"\n`);
  process.stdout.write(`export API_SECRET="${API_SECRET}"\n`);
  process.stdout.write(`export ENCRYPTION_KEY="${ENCRYPTION_KEY}"\n`);

  rl.close();
}

main().catch(console.error);
