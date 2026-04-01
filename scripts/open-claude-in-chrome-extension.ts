#!/usr/bin/env bun

import { openInChrome } from '../src/utils/claudeInChrome/common.ts'
import { CHROME_EXTENSION_URL } from '../src/utils/claudeInChrome/setupPortable.ts'

const opened = await openInChrome(CHROME_EXTENSION_URL)

if (!opened) {
  console.error(
    'Unable to open a supported Chromium browser automatically. Visit ' +
      CHROME_EXTENSION_URL +
      ' manually.',
  )
  process.exit(1)
}

console.log('Opened Claude in Chrome install page: ' + CHROME_EXTENSION_URL)
