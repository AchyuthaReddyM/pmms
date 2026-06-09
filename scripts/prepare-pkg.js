// scripts/prepare-pkg.js
//
// Ensures the better-sqlite3 native binary in node_modules matches the Node
// version that pkg will bundle into PMMS.exe. Without this step, you get:
//
//   Error: The module '...\better_sqlite3.node' was compiled against a
//   different Node.js version using NODE_MODULE_VERSION xxx. This version
//   of Node.js requires NODE_MODULE_VERSION yyy.
//
// Why: `npm install` downloads the better-sqlite3 prebuilt binary for whatever
// Node version is currently installed on the build machine. But pkg embeds a
// fixed Node runtime (defined by the pkg target in package.json — node20 here),
// so the two versions can drift apart. This script re-fetches the right prebuild.
//
// Run automatically by `npm run build:exe`. Safe to re-run.

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

// Keep this in sync with the pkg target in package.json ("node20-win-x64" -> "20.x.x").
// pkg ships Node 20 LTS (currently 20.18.x). Picking the latest 20.x is fine.
const TARGET_NODE_VERSION = '20.18.0';
const TARGET_PLATFORM     = 'win32';
const TARGET_ARCH         = 'x64';

const ROOT      = path.join(__dirname, '..');
const BSQL_DIR  = path.join(ROOT, 'node_modules', 'better-sqlite3');

function die(msg) {
  console.error(`\n[prepare-pkg] ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(BSQL_DIR)) {
  die("node_modules/better-sqlite3 not found. Run `npm install` first.");
}

console.log(`\n[prepare-pkg] Re-downloading better-sqlite3 prebuild for Node ${TARGET_NODE_VERSION} / ${TARGET_PLATFORM}-${TARGET_ARCH}...`);
console.log(`[prepare-pkg] (so the .node binary matches the runtime pkg will bundle)`);

try {
  execSync(
    `npx --yes prebuild-install --runtime=node --target=${TARGET_NODE_VERSION} --arch=${TARGET_ARCH} --platform=${TARGET_PLATFORM} --force`,
    { cwd: BSQL_DIR, stdio: 'inherit' }
  );
} catch (e) {
  die("Failed to fetch the prebuilt binary. Check internet access and that better-sqlite3 publishes a prebuild for this Node version on GitHub releases.");
}

// Sanity check: the .node file should now exist where pkg expects it.
const NODE_BIN = path.join(BSQL_DIR, 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(NODE_BIN)) {
  die(`Expected ${NODE_BIN} after prebuild-install, but it's not there.`);
}

const sizeKB = (fs.statSync(NODE_BIN).size / 1024).toFixed(0);
console.log(`[prepare-pkg] OK — better_sqlite3.node refreshed (${sizeKB} KB).\n`);
