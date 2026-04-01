import { createHash } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { unzipSync } from 'fflate'

export const OFFICIAL_CLAUDE_IN_CHROME_EXTENSION_ID =
  'fcoeoabgfenejglbffodgkkbkcdhcgfn'

export const OFFICIAL_CLAUDE_IN_CHROME_UPDATE_URL =
  'https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=123.0.0.0&acceptformat=crx3&x=id%3Dfcoeoabgfenejglbffodgkkbkcdhcgfn%26uc'

export type OfficialClaudeExtensionPaths = {
  chromeHomeDir: string
  rootDir: string
  updateXmlPath: string
  crxPath: string
  unpackedDir: string
  logPath: string
}

export type OfficialClaudeExtensionMetadata = {
  codebaseUrl: string
  version: string
}

export function getClaudeChromeHomeDir(): string {
  return join(homedir(), '.claude', 'chrome')
}

export function getOfficialClaudeExtensionPaths(
  chromeHomeDir = getClaudeChromeHomeDir(),
): OfficialClaudeExtensionPaths {
  const rootDir = join(chromeHomeDir, 'official-extension')
  return {
    chromeHomeDir,
    rootDir,
    updateXmlPath: join(rootDir, 'update.xml'),
    crxPath: join(rootDir, 'claude.crx'),
    unpackedDir: join(rootDir, 'unpacked'),
    logPath: join(rootDir, 'chrome.log'),
  }
}

export function getIsolatedChromeProfilePaths(
  profileName = 'direct-profile',
  chromeHomeDir = getClaudeChromeHomeDir(),
): {
  profileDir: string
  nativeMessagingHostsDir: string
  nativeHostManifestPath: string
} {
  const profileDir = join(chromeHomeDir, profileName)
  const nativeMessagingHostsDir = join(profileDir, 'NativeMessagingHosts')
  return {
    profileDir,
    nativeMessagingHostsDir,
    nativeHostManifestPath: join(
      nativeMessagingHostsDir,
      'com.anthropic.claude_code_browser_extension.json',
    ),
  }
}

export function parseChromeExtensionUpdateXml(
  xml: string,
): OfficialClaudeExtensionMetadata {
  const updateCheckTag = xml.match(/<updatecheck\b([^>]+)>/i)?.[1]
  if (!updateCheckTag) {
    throw Error('Failed to parse Chrome extension update XML')
  }

  const codebaseMatch = updateCheckTag.match(/\bcodebase="([^"]+)"/)
  const versionMatch = updateCheckTag.match(/\bversion="([^"]+)"/)

  if (!codebaseMatch?.[1] || !versionMatch?.[1]) {
    throw Error('Failed to parse Chrome extension update XML')
  }

  return {
    codebaseUrl: codebaseMatch[1],
    version: versionMatch[1],
  }
}

export function stripCrxContainer(crxData: Uint8Array): Uint8Array {
  const payload = Buffer.from(crxData)

  if (payload.subarray(0, 4).toString('ascii') !== 'Cr24') {
    throw Error('Invalid CRX header')
  }

  const version = payload.readUInt32LE(4)
  let headerLength: number

  switch (version) {
    case 2: {
      const publicKeyLength = payload.readUInt32LE(8)
      const signatureLength = payload.readUInt32LE(12)
      headerLength = 16 + publicKeyLength + signatureLength
      break
    }
    case 3: {
      const protobufHeaderLength = payload.readUInt32LE(8)
      headerLength = 12 + protobufHeaderLength
      break
    }
    default:
      throw Error(`Unsupported CRX version: ${version}`)
  }

  return payload.subarray(headerLength)
}

export function deriveChromeExtensionIdFromPublicKey(
  publicKeyBase64: string,
): string {
  const digest = createHash('sha256')
    .update(Buffer.from(publicKeyBase64, 'base64'))
    .digest()
    .subarray(0, 16)
  const alphabet = 'abcdefghijklmnop'

  return Array.from(
    digest,
    byte => alphabet[(byte >> 4) & 0x0f] + alphabet[byte & 0x0f],
  ).join('')
}

export async function unpackCrxToDirectory(
  crxData: Uint8Array,
  outputDir: string,
): Promise<void> {
  const zipEntries = unzipSync(stripCrxContainer(crxData))

  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })

  for (const [relativePath, fileData] of Object.entries(zipEntries)) {
    if (relativePath.endsWith('/')) {
      continue
    }
    const targetPath = join(outputDir, relativePath)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, fileData)
  }
}

export async function downloadOfficialClaudeExtension(
  paths = getOfficialClaudeExtensionPaths(),
): Promise<{
  metadata: OfficialClaudeExtensionMetadata
  manifest: {
    name: string
    version: string
    key?: string
  }
}> {
  await mkdir(paths.rootDir, { recursive: true })

  const updateResponse = await fetch(OFFICIAL_CLAUDE_IN_CHROME_UPDATE_URL)
  if (!updateResponse.ok) {
    throw Error(
      `Failed to fetch extension update XML: ${updateResponse.status} ${updateResponse.statusText}`,
    )
  }

  const updateXml = await updateResponse.text()
  const metadata = parseChromeExtensionUpdateXml(updateXml)
  await writeFile(paths.updateXmlPath, updateXml, 'utf8')

  const crxResponse = await fetch(metadata.codebaseUrl)
  if (!crxResponse.ok) {
    throw Error(
      `Failed to download extension CRX: ${crxResponse.status} ${crxResponse.statusText}`,
    )
  }

  const crxData = new Uint8Array(await crxResponse.arrayBuffer())
  await writeFile(paths.crxPath, crxData)
  await unpackCrxToDirectory(crxData, paths.unpackedDir)

  const manifest = await readOfficialClaudeExtensionManifest(paths.unpackedDir)
  return {
    metadata,
    manifest,
  }
}

export async function readOfficialClaudeExtensionManifest(
  unpackedDir: string,
): Promise<{
  name: string
  version: string
  key?: string
}> {
  const manifestPath = join(unpackedDir, 'manifest.json')
  const raw = await readFile(manifestPath, 'utf8')
  const parsed = JSON.parse(raw) as {
    name?: unknown
    version?: unknown
    key?: unknown
  }

  return {
    name: typeof parsed.name === 'string' ? parsed.name : 'Unknown',
    version: typeof parsed.version === 'string' ? parsed.version : 'Unknown',
    key: typeof parsed.key === 'string' ? parsed.key : undefined,
  }
}
