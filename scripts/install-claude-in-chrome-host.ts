#!/usr/bin/env bun

import {
  installChromeNativeHostSupport,
  resolveChromeNativeHostCommand,
} from '../src/utils/claudeInChrome/setup.ts'

const command = resolveChromeNativeHostCommand()
const wrapperPath = await installChromeNativeHostSupport(command)

console.log('Installed Claude in Chrome native host support')
console.log('Command: ' + command)
console.log('Wrapper: ' + wrapperPath)
