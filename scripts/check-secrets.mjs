import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ignoredDirectories = new Set(['.git', 'node_modules', '.wrangler', 'coverage', 'dist']);
const binaryExtensions = new Set(['.png','.jpg','.jpeg','.gif','.webp','.ico','.zip','.pdf','.woff','.woff2']);
const allowedExamples = new Set(['.env.example', '.dev.vars.example']);
const forbiddenFiles = [/(^|\/)\.env(?:\.|$)/,/(^|\/)\.dev\.vars(?:\.|$)/,/(^|\/)credentials\.json$/i,/(^|\/)service-account[^/]*\.json$/i,/\.(?:pem|key|p12|pfx)$/i];
const signatures = [
  ['generic API secret', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g],
];

const findings = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) { walk(absolute); continue; }
    if (!entry.isFile()) continue;
    if (!allowedExamples.has(path.basename(relative)) && forbiddenFiles.some(pattern => pattern.test(relative))) {
      findings.push(`${relative}: secret-bearing file type must not be committed`);
      continue;
    }
    if (binaryExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    let text;
    try { text = fs.readFileSync(absolute, 'utf8'); } catch { continue; }
    for (const [label, pattern] of signatures) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) findings.push(`${relative}: possible ${label}`);
    }
  }
}
walk(root);
if (findings.length) {
  console.error('Potential secret material detected:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log('Secret scan passed.');
