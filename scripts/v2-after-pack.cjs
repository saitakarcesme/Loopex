const { execFileSync } = require('node:child_process')
const path = require('node:path')

// Finder metadata inherited while copying bundles is not part of the product.
// Remove only those two metadata attributes; retain quarantine/provenance and
// all access controls. codesign rejects resource forks and FinderInfo.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  for (const attribute of ['com.apple.FinderInfo', 'com.apple.ResourceFork']) {
    try { execFileSync('/usr/bin/xattr', ['-dr', attribute, bundle], { stdio: 'pipe' }) }
    catch (error) {
      const detail = String(error.stderr || '')
      if (!detail.includes('No such xattr')) throw error
    }
  }
}
