import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const historyMode = process.argv.includes('--history');
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

const findings = new Set();

function scanText(label, text) {
  for (const [signatureLabel, pattern] of signatures) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.add(`${label}: possible ${signatureLabel}`);
  }
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) { walk(absolute); continue; }
    if (!entry.isFile()) continue;
    if (!allowedExamples.has(path.basename(relative)) && forbiddenFiles.some(pattern => pattern.test(relative))) {
      findings.add(`${relative}: secret-bearing file type must not be committed`);
      continue;
    }
    if (binaryExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    let text;
    try { text = fs.readFileSync(absolute, 'utf8'); } catch { continue; }
    scanText(relative, text);
  }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function scanHistory() {
  if (!fs.existsSync(path.join(root, '.git'))) throw new Error('Git history scan requires a Git checkout.');

  const historicalNames = git(['log', '--all', '--name-only', '--pretty=format:'])
    .split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  for (const relative of historicalNames) {
    if (!allowedExamples.has(path.basename(relative)) && forbiddenFiles.some(pattern => pattern.test(relative))) {
      findings.add(`${relative}: secret-bearing file type exists in Git history`);
    }
  }

  const commits = git(['rev-list', '--all']).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  for (const commit of commits) {
    const patch = git(['show', '--format=', '--no-ext-diff', '--no-renames', '--find-copies-harder', commit]);
    scanText(`commit ${commit.slice(0, 12)}`, patch);
  }
}

if (historyMode) scanHistory();
else walk(root);

if (findings.size) {
  console.error('Potential secret material detected:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(historyMode ? 'Git history secret scan passed.' : 'Secret scan passed.');