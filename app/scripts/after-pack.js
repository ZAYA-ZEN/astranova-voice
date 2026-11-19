// ใส่ไอคอน/ชื่อให้ไฟล์ .exe (ไม่ต้องใช้ wine)
const fs = require("fs");
const path = require("path");
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== "win32") return;
  const ResEdit = require("resedit");
  const exe = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + ".exe");
  const data = fs.readFileSync(exe);
  const exeObj = ResEdit.NtExecutable.from(data, { ignoreCert: true });
  const r = ResEdit.NtExecutableResource.from(exeObj);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, "..", "electron", "icon.ico")));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(r.entries);
  const id = groups.length ? groups[0].id : 1, lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(r.entries, id, lang, ico.icons.map((i) => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(r.entries)[0];
  if (vi) {
    vi.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: "Astra Nova Voice", FileDescription: "Astra Nova Voice", CompanyName: "Astra Nova" });
    vi.outputToResourceEntries(r.entries);
  }
  r.outputResource(exeObj);
  fs.writeFileSync(exe, Buffer.from(exeObj.generate()));
  console.log("  • icon set on", path.basename(exe));
};
