// electron-builder afterPack hook: flip Electron fuses on the packaged binary
// to disable ELECTRON_RUN_AS_NODE and Node CLI inspect arguments, so the
// shipped executable cannot be relaunched to run arbitrary Node code
// (Electron security checklist A19). The app never relies on either — it
// spawns the standalone Claude CLI and loads better-sqlite3 as a native module.
import { FuseVersion, FuseV1Options, flipFuses } from '@electron/fuses'
import { join } from 'node:path'

export default async function afterPack(context) {
  const productName = context.packager.appInfo.productFilename
  const platform = context.electronPlatformName
  const binary =
    platform === 'darwin'
      ? join(context.appOutDir, `${productName}.app`)
      : join(context.appOutDir, `${productName}${platform === 'win32' ? '.exe' : ''}`)

  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  })
  console.log(`[after-pack] fuses flipped on ${binary}`)
}
