import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['app.js', 'pilot-controls.js', 'sw.js', 'shared', 'functions', 'scripts', 'tests'];
const sourceFiles = [];

for (const root of roots) collect(root);
sourceFiles.sort();

for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

JSON.parse(fs.readFileSync('manifest.webmanifest', 'utf8'));
const routes = JSON.parse(fs.readFileSync('_routes.json', 'utf8'));
if (routes.version !== 1 || JSON.stringify(routes.include) !== '["/api/*"]' || !Array.isArray(routes.exclude)) {
  throw new Error('Invalid _routes.json policy.');
}

const migrations = fs.readdirSync('migrations')
  .filter(name => /^\d{4}_.+\.sql$/.test(name))
  .sort();
if (new Set(migrations).size !== migrations.length) throw new Error('Duplicate migration names detected.');
if (!migrations.includes('0005_session_audit_hardening.sql')) throw new Error('Latest hardening migration is missing.');

console.log(`Syntax/config check passed for ${sourceFiles.length} JavaScript files and ${migrations.length} migrations.`);

function collect(entry) {
  const stat = fs.statSync(entry);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(entry)) collect(path.join(entry, child));
    return;
  }
  if (/\.(?:js|mjs)$/.test(entry)) sourceFiles.push(entry);
}
