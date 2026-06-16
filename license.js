// =============================================================================
// PMMS Licensing — RSA-signed offline licenses
// -----------------------------------------------------------------------------
// Threat model and choices documented in BUILD-EXE.md.
//
// Format:
//     <base64(json_payload)>.<base64(RSA-PSS-SHA256 signature)>
//
// JSON payload:
//     { v:1, fp:"<hex>", exp:"YYYY-MM-DD", iat:"<ISO>", customer:"…", notes:"…" }
//
// Fingerprint is sha256( MachineGuid + ":" + VolumeSerial(C:) ) — first 32 hex
// chars. Both inputs come from the Windows registry / `vol` command; if either
// is unavailable (e.g. running on Linux dev box), the licensing layer
// short-circuits to allow startup so the app remains developable.
//
// The PUBLIC KEY below is generated once by `tools/make_keypair.py` and pasted
// in. It is safe to commit — it only verifies, it can't sign.
// =============================================================================

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// PUBLIC KEY — REPLACE THIS BLOCK AFTER RUNNING tools/make_keypair.py
// ---------------------------------------------------------------------------
// Until you replace this with a real key, licensing is DISABLED — the app
// will print a warning at startup and run unrestricted.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
__REPLACE_WITH_OUTPUT_FROM_make_keypair_py__
-----END PUBLIC KEY-----`;

const KEY_IS_PLACEHOLDER = PUBLIC_KEY_PEM.includes('__REPLACE_WITH_OUTPUT_FROM_make_keypair_py__');

// ---------------------------------------------------------------------------
// License file path — sits next to the .exe when packaged, or next to
// server.js when running from source. Matches the pmms.db convention.
// ---------------------------------------------------------------------------
function licenseFilePath() {
  // When running under pkg, process.pkg is truthy and process.execPath is the .exe path.
  const baseDir = process.pkg
    ? path.dirname(process.execPath)
    : __dirname;
  return process.env.PMMS_LICENSE_PATH || path.join(baseDir, 'license.txt');
}

// ---------------------------------------------------------------------------
// Hardware fingerprint — Windows MachineGuid + C: volume serial
// ---------------------------------------------------------------------------
function readMachineGuid() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
      encoding: 'utf8', stdio: ['ignore','pipe','ignore'],
    });
    const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
    return m ? m[1].trim() : null;
  } catch (e) { return null; }
}

function readVolumeSerial(drive = 'C:') {
  if (process.platform !== 'win32') return null;
  try {
    // `vol C:` prints something like:
    //   Volume in drive C is OS
    //   Volume Serial Number is 1234-ABCD
    const out = execSync(`vol ${drive}`, {
      encoding: 'utf8', stdio: ['ignore','pipe','ignore'],
    });
    const m = out.match(/Serial Number is ([A-F0-9-]+)/i);
    return m ? m[1].replace(/-/g, '').trim() : null;
  } catch (e) { return null; }
}

let _fingerprintCache = null;
function getFingerprint() {
  if (_fingerprintCache) return _fingerprintCache;
  const guid = readMachineGuid()    || 'unknown-machineguid';
  const vol  = readVolumeSerial()   || 'unknown-volserial';
  const fp = crypto.createHash('sha256')
    .update(`${guid}:${vol}`)
    .digest('hex')
    .slice(0, 32);
  _fingerprintCache = {
    fingerprint: fp,
    machine_guid_present: guid !== 'unknown-machineguid',
    volume_serial_present: vol !== 'unknown-volserial',
    platform: process.platform,
  };
  return _fingerprintCache;
}

// ---------------------------------------------------------------------------
// License verification
// ---------------------------------------------------------------------------
function verifyLicenseString(licenseStr) {
  if (!licenseStr || typeof licenseStr !== 'string') return { ok: false, error: 'empty' };
  const parts = licenseStr.trim().split('.');
  if (parts.length !== 2) return { ok: false, error: 'malformed (expected payload.signature)' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8'));
  } catch (e) {
    return { ok: false, error: 'unreadable payload' };
  }
  let signature;
  try {
    signature = Buffer.from(parts[1], 'base64');
  } catch (e) {
    return { ok: false, error: 'unreadable signature' };
  }
  const dataToVerify = Buffer.from(parts[0]); // verify the exact base64 bytes
  let valid;
  try {
    valid = crypto.verify(
      'sha256',
      dataToVerify,
      {
        key: PUBLIC_KEY_PEM,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      signature
    );
  } catch (e) {
    return { ok: false, error: 'signature verify error: ' + e.message };
  }
  if (!valid) return { ok: false, error: 'signature does not match public key' };
  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Full license state computation
// ---------------------------------------------------------------------------
function computeLicenseState() {
  // If the public key hasn't been replaced from the placeholder, licensing is
  // not yet wired — log loudly but don't block (developer mode).
  if (KEY_IS_PLACEHOLDER) {
    return {
      valid: true,
      mode: 'unconfigured',
      reason: 'Public key not yet generated. Run tools/make_keypair.py and paste the public key into license.js.',
      fingerprint: getFingerprint().fingerprint,
    };
  }
  // Skip enforcement entirely when not running under pkg — i.e. dev / Render / CI.
  if (!process.pkg && !process.env.PMMS_ENFORCE_LICENSE) {
    return {
      valid: true,
      mode: 'dev',
      reason: 'Not running as packaged exe — license enforcement skipped. Set PMMS_ENFORCE_LICENSE=1 to test.',
      fingerprint: getFingerprint().fingerprint,
    };
  }
  // Try to load license.txt
  const filePath = licenseFilePath();
  let licenseStr = null;
  try {
    licenseStr = fs.readFileSync(filePath, 'utf8').trim();
  } catch (e) {
    return {
      valid: false,
      mode: 'missing',
      reason: 'No license.txt found. Send your fingerprint to the licensor and paste the returned license key.',
      fingerprint: getFingerprint().fingerprint,
      file_path: filePath,
    };
  }
  const v = verifyLicenseString(licenseStr);
  if (!v.ok) {
    return {
      valid: false,
      mode: 'invalid',
      reason: 'License signature invalid: ' + v.error,
      fingerprint: getFingerprint().fingerprint,
      file_path: filePath,
    };
  }
  const payload = v.payload;
  const fp = getFingerprint().fingerprint;
  if (!payload.fp || payload.fp.toLowerCase() !== fp.toLowerCase()) {
    return {
      valid: false,
      mode: 'wrong_machine',
      reason: `License was issued for a different machine fingerprint (expected ${fp}, got ${payload.fp}).`,
      fingerprint: fp,
      file_path: filePath,
    };
  }
  // Expiry — date-only comparison (UTC, YYYY-MM-DD)
  if (payload.exp) {
    const today = new Date().toISOString().slice(0, 10);
    if (today > payload.exp) {
      return {
        valid: false,
        mode: 'expired',
        reason: `License expired on ${payload.exp}.`,
        fingerprint: fp,
        expiry: payload.exp,
        customer: payload.customer,
        file_path: filePath,
      };
    }
    // Grace warning if within 14 days of expiry
    const expiryDate = new Date(payload.exp + 'T00:00:00Z');
    const todayDate = new Date(today + 'T00:00:00Z');
    const daysLeft = Math.floor((expiryDate - todayDate) / 86400000);
    return {
      valid: true,
      mode: 'active',
      fingerprint: fp,
      expiry: payload.exp,
      days_remaining: daysLeft,
      expiring_soon: daysLeft <= 14,
      customer: payload.customer,
      issued_at: payload.iat,
      notes: payload.notes,
      file_path: filePath,
    };
  }
  // No expiry — perpetual license
  return {
    valid: true,
    mode: 'perpetual',
    fingerprint: fp,
    customer: payload.customer,
    issued_at: payload.iat,
    notes: payload.notes,
    file_path: filePath,
  };
}

// Cached state (re-computed on upload + at intervals)
let _state = null;
function getState() {
  if (!_state) _state = computeLicenseState();
  return _state;
}
function refreshState() {
  _state = computeLicenseState();
  return _state;
}

// ---------------------------------------------------------------------------
// Save a new license to disk (called by the upload endpoint)
// ---------------------------------------------------------------------------
function saveLicense(licenseStr) {
  const v = verifyLicenseString(licenseStr);
  if (!v.ok) throw new Error('License signature invalid: ' + v.error);
  const fp = getFingerprint().fingerprint;
  if (!v.payload.fp || v.payload.fp.toLowerCase() !== fp.toLowerCase()) {
    throw new Error(`License was issued for a different machine fingerprint (expected ${fp}, got ${v.payload.fp}).`);
  }
  if (v.payload.exp) {
    const today = new Date().toISOString().slice(0, 10);
    if (today > v.payload.exp) throw new Error(`License already expired on ${v.payload.exp}.`);
  }
  fs.writeFileSync(licenseFilePath(), licenseStr.trim() + '\n', 'utf8');
  refreshState();
  return getState();
}

// ---------------------------------------------------------------------------
// Express middleware — block /api/* except license endpoints when invalid
// ---------------------------------------------------------------------------
function requireValidLicense(req, res, next) {
  const s = getState();
  if (s.valid) return next();
  // Always allow license endpoints + static files
  if (req.path.startsWith('/api/license/')) return next();
  // Static assets (no /api/ prefix) handled by the static middleware — we only
  // gate /api/* calls here. The frontend reads /api/license/info to detect the
  // state and renders the license screen accordingly.
  return res.status(402).json({
    error: 'License required',
    license_state: { valid: false, mode: s.mode, reason: s.reason, fingerprint: s.fingerprint },
  });
}

module.exports = {
  getFingerprint,
  verifyLicenseString,
  computeLicenseState,
  getState,
  refreshState,
  saveLicense,
  requireValidLicense,
  KEY_IS_PLACEHOLDER,
};
