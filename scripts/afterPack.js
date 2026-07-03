'use strict';

// electron-builder afterPack hook (macOS only).
//
// Electron ships its own Info.plist with a set of default privacy
// usage-description strings (camera, microphone, bluetooth, audio capture).
// Screenchart uses NONE of those APIs — it needs SCREEN RECORDING only, which
// we declare via build.mac.extendInfo (NSScreenCaptureUsageDescription).
//
// These stray keys don't trigger a prompt on their own, but they show up if a
// user inspects the app and read as "why does a screenshot tool want my camera?"
// So we strip them here to keep the declared privacy surface to exactly one key:
// screen recording. The Delete keys below are also a defensive backstop against a
// future Electron adding Photos/Desktop/Documents/Downloads descriptions.
//
// PlistBuddy (built into macOS) is deterministic; Delete on a missing key throws,
// which we swallow per key so the hook is idempotent.

const path = require('path');
const { execFileSync } = require('child_process');

const STRIP = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSAudioCaptureUsageDescription',
  // Defensive: never ship any of these even if Electron starts adding them.
  'NSPhotoLibraryUsageDescription',
  'NSPhotoLibraryAddUsageDescription',
  'NSDesktopFolderUsageDescription',
  'NSDocumentsFolderUsageDescription',
  'NSDownloadsFolderUsageDescription',
  'NSContactsUsageDescription',
  'NSLocationWhenInUseUsageDescription',
];

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const plist = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Info.plist');

  let removed = 0;
  for (const key of STRIP) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plist], { stdio: 'ignore' });
      removed++;
    } catch (_) { /* key absent — fine, hook stays idempotent */ }
  }
  console.log(`[afterPack] ${appName}.app: stripped ${removed} unused usage-description key(s); screen recording is the only one declared.`);
};
