#!/usr/bin/env bun

import {
  deriveChromeExtensionIdFromPublicKey,
  downloadOfficialClaudeExtension,
  getOfficialClaudeExtensionPaths,
  OFFICIAL_CLAUDE_IN_CHROME_EXTENSION_ID,
} from '../src/utils/claudeInChrome/officialExtension.ts'

const paths = getOfficialClaudeExtensionPaths()
const { metadata, manifest } = await downloadOfficialClaudeExtension(paths)

console.log('Downloaded official Claude in Chrome extension')
console.log('Update URL: ' + metadata.codebaseUrl)
console.log('Manifest version: ' + manifest.version)
console.log('Name: ' + manifest.name)
console.log('CRX: ' + paths.crxPath)
console.log('Unpacked: ' + paths.unpackedDir)

if (manifest.key) {
  const derivedId = deriveChromeExtensionIdFromPublicKey(manifest.key)
  console.log('Derived extension id: ' + derivedId)
  if (derivedId !== OFFICIAL_CLAUDE_IN_CHROME_EXTENSION_ID) {
    throw Error(
      'Official CRX unpacked, but derived extension id does not match production id',
    )
  }
}
