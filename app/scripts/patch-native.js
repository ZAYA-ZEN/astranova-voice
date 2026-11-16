// ปรับโปรเจกต์ Android/iOS ที่ Capacitor สร้าง: สิทธิ์ไมค์, ทำงานเบื้องหลัง, ไอคอน, โค้ดเสียง native
const fs = require("fs");
const path = require("path");
const which = process.argv[2];

if (which === "android") {
  const p = "android/app/src/main/AndroidManifest.xml";
  let s = fs.readFileSync(p, "utf8");
  const perms = ["INTERNET", "RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS", "WAKE_LOCK", "FOREGROUND_SERVICE",
    "FOREGROUND_SERVICE_MICROPHONE", "FOREGROUND_SERVICE_MEDIA_PLAYBACK", "POST_NOTIFICATIONS", "ACCESS_WIFI_STATE"];
  for (const x of perms) if (!s.includes(`android.permission.${x}"`)) s = s.replace("</manifest>", `    <uses-permission android:name="android.permission.${x}" />\n</manifest>`);
  if (!s.includes("usesCleartextTraffic")) s = s.replace("<application", '<application android:usesCleartextTraffic="true"');
  if (!s.includes(".VoiceService")) s = s.replace("</application>",
    '        <service android:name=".VoiceService" android:exported="false" android:foregroundServiceType="microphone|mediaPlayback" />\n    </application>');
  fs.writeFileSync(p, s);
  console.log("patched", p);
}

if (which === "ios") {
  // 1) Info.plist
  const p = "ios/App/App/Info.plist";
  let s = fs.readFileSync(p, "utf8");
  const add = `
	<key>NSMicrophoneUsageDescription</key>
	<string>ใช้ไมโครโฟนเพื่อคุยกับผู้เล่นใกล้ๆ ในเกม</string>
	<key>NSAppTransportSecurity</key>
	<dict><key>NSAllowsArbitraryLoads</key><true/></dict>
	<key>UIBackgroundModes</key>
	<array><string>audio</string></array>
`;
  if (!s.includes("NSMicrophoneUsageDescription")) s = s.replace(/<dict>/, "<dict>" + add);
  fs.writeFileSync(p, s);
  // 2) โค้ด Swift
  for (const f of fs.readdirSync("native-ios")) fs.copyFileSync(path.join("native-ios", f), path.join("ios/App/App", f));
  // 3) ใช้ ViewController ของเราที่ลงทะเบียน plugin
  const sb = "ios/App/App/Base.lproj/Main.storyboard";
  let t = fs.readFileSync(sb, "utf8");
  t = t.replace(/customClass="CAPBridgeViewController" customModule="Capacitor"/, 'customClass="AstraViewController" customModule="App" customModuleProvider="target"');
  fs.writeFileSync(sb, t);
  // 4) ไอคอน
  const icon = "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png";
  if (fs.existsSync("icon-1024.png")) fs.copyFileSync("icon-1024.png", icon);
  console.log("patched ios (ต้องรัน scripts/add-ios-files.rb เพื่อเพิ่มไฟล์ Swift เข้าโปรเจกต์ Xcode)");
}
