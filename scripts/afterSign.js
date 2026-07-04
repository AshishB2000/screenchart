'use strict';

// electron-builder afterSign hook (macOS only).
//
// PROBLEM: the release build was shipping Electron's generic LINKER signature
// (Identifier=Electron, adhoc, Info.plist NOT bound, resources sealed=none). That
// weak/generic identity is why macOS would not HOLD the Screen Recording (TCC)
// grant across relaunches — the app that re-launched didn't match the one that was
// granted.
//
// FIX (free ad-hoc signing — NO Apple certificate, NO notarization): force a
// COMPLETE ad-hoc signature ("--sign -") bound to our REAL bundle identifier, with
// a runtime seal and our entitlements, AFTER electron-builder has signed. This
// makes the final .app: Identifier=app.screenshot.desktop, Signature=adhoc,
// Info.plist bound, resources sealed — a stable identity the TCC grant sticks to.
//
// This runs after afterPack (which strips stray usage-description keys), so the
// signature seals the already-cleaned Info.plist.

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const BUNDLE_ID = 'app.screenshot.desktop';
const ENTITLEMENTS = path.join(__dirname, '..', 'build', 'entitlements.mac.plist');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // Ad-hoc re-sign with our identifier + a complete, sealed signature.
  console.log(`[afterSign] ad-hoc re-signing ${appName}.app as ${BUNDLE_ID}…`);
  execFileSync('codesign', [
    '--force',
    '--deep',
    '--sign', '-',                       // ad-hoc: no certificate needed
    '--identifier', BUNDLE_ID,           // bind to our real id, not "Electron"
    '--options', 'runtime',              // hardened runtime → complete seal
    '--entitlements', ENTITLEMENTS,
    '--timestamp=none',                  // ad-hoc has no trusted timestamp
    appPath,
  ], { stdio: 'inherit' });

  // Verify the seal is strict AND bound to our identifier — fail the build if not,
  // so a regression can never ship silently.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });

  const dv = spawnSync('codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
  const info = `${dv.stderr || ''}${dv.stdout || ''}`;
  const id = (info.match(/^Identifier=(.+)$/m) || [])[1];
  if (id !== BUNDLE_ID) {
    throw new Error(`[afterSign] Identifier is "${id}", expected "${BUNDLE_ID}" — signature not bound correctly.`);
  }
  const sealed = /Sealed Resources/.test(info) && !/Sealed Resources=none/.test(info);
  const bound = !/Info\.plist=not bound/.test(info);
  console.log(`[afterSign] OK — Identifier=${id}, adhoc, Info.plist bound=${bound}, sealed resources=${sealed}.`);
};
