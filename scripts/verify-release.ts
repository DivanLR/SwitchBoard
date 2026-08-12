// Gate run before/after `gh release create`: refuses to pass unless
// release/latest.yml actually matches the installer on disk. Without this,
// a stale latest.yml (wrong version, or regenerated after a re-build changed
// the exe) ships silently and users auto-update into an installer that either
// electron-updater can't find or whose hash check fails client-side.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
console.log(`checking package.json version: ${pkg.version}`);

const yamlPath = join(root, 'release', 'latest.yml');
if (!existsSync(yamlPath)) {
  fail(`${yamlPath} does not exist. Run "npm run package" to generate it.`);
}
const yamlText = readFileSync(yamlPath, 'utf8');
console.log(`checking ${yamlPath} exists: found`);

// electron-builder's latest.yml is flat top-level keys plus one indented
// "files:" list. Matching only unindented "key: value" lines parses the
// fields we need without a YAML dependency and without picking up the
// per-file sha512 nested inside files:.
const top: Record<string, string> = {};
for (const line of yamlText.split(/\r?\n/)) {
  const m = /^(\w+):\s*(.*)$/.exec(line);
  if (m) top[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
}

if (!top.version || !top.path || !top.sha512) {
  fail(
    `${yamlPath} is missing a top-level version/path/sha512 field. ` +
      'It does not have the shape electron-builder writes; regenerate it with "npm run package".',
  );
}
console.log(`checking latest.yml parses: version=${top.version} path=${top.path}`);

if (top.version !== pkg.version) {
  fail(
    `latest.yml version "${top.version}" does not match package.json version "${pkg.version}". ` +
      'Bump package.json and rebuild, or you will publish a release under the wrong version.',
  );
}
console.log('checking version matches package.json: match');

const installerPath = join(root, 'release', top.path);
if (!existsSync(installerPath)) {
  fail(`installer "${top.path}" named in latest.yml does not exist at ${installerPath}. Rebuild with "npm run package".`);
}
console.log(`checking installer exists on disk: found ${installerPath}`);

const actualSha512 = createHash('sha512').update(readFileSync(installerPath)).digest('base64');
if (actualSha512 !== top.sha512) {
  fail(
    `SHA-512 mismatch for ${top.path}: latest.yml records "${top.sha512}" but the file on disk hashes to "${actualSha512}". ` +
      'The installer was rebuilt without regenerating latest.yml (or vice versa) — auto-update would fail the client-side hash check.',
  );
}
console.log('checking SHA-512 matches installer on disk: match');

console.log('OK: release is publishable — installer and latest.yml agree.');
