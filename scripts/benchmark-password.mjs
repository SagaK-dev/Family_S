const ITERATIONS = 600_000;
const ROUNDS = 3;
const encoder = new TextEncoder();
const password = encoder.encode('pilot-benchmark-password');
const salt = new Uint8Array(16);
crypto.getRandomValues(salt);

const key = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
const samples = [];
for (let index = 0; index < ROUNDS; index += 1) {
  const start = performance.now();
  await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  samples.push(performance.now() - start);
}

const averageMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
console.log(JSON.stringify({
  runtime: `node-${process.versions.node}`,
  algorithm: 'PBKDF2-HMAC-SHA256',
  iterations: ITERATIONS,
  rounds: ROUNDS,
  samplesMs: samples.map(value => Number(value.toFixed(2))),
  averageMs: Number(averageMs.toFixed(2)),
  note: 'This validates the KDF path only. It is not a substitute for measuring Cloudflare Workers CPU time.',
}, null, 2));