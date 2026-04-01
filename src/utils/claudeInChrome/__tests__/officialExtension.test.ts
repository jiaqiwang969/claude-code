import { describe, expect, test } from 'bun:test'
import {
  deriveChromeExtensionIdFromPublicKey,
  parseChromeExtensionUpdateXml,
  stripCrxContainer,
} from '../officialExtension.js'

describe('officialExtension helpers', () => {
  test('parseChromeExtensionUpdateXml extracts codebase and version', () => {
    const xml = `
      <gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
        <app appid="fcoeoabgfenejglbffodgkkbkcdhcgfn">
          <updatecheck
            codebase="https://clients2.googleusercontent.com/crx/blobs/demo/CLAUDE_1_0_66_0.crx"
            version="1.0.66"
          />
        </app>
      </gupdate>
    `

    expect(parseChromeExtensionUpdateXml(xml)).toEqual({
      codebaseUrl:
        'https://clients2.googleusercontent.com/crx/blobs/demo/CLAUDE_1_0_66_0.crx',
      version: '1.0.66',
    })
  })

  test('stripCrxContainer removes v2 header', () => {
    const zipPayload = Buffer.from('PK\x03\x04demo-v2', 'binary')
    const crx = Buffer.concat([
      Buffer.from('Cr24', 'ascii'),
      Buffer.from([2, 0, 0, 0]),
      Buffer.alloc(8),
      zipPayload,
    ])

    expect(Buffer.from(stripCrxContainer(crx))).toEqual(zipPayload)
  })

  test('stripCrxContainer removes v3 header', () => {
    const zipPayload = Buffer.from('PK\x03\x04demo-v3', 'binary')
    const protobufHeader = Buffer.from([1, 2, 3, 4, 5, 6])
    const crx = Buffer.concat([
      Buffer.from('Cr24', 'ascii'),
      Buffer.from([3, 0, 0, 0]),
      Buffer.from([protobufHeader.length, 0, 0, 0]),
      protobufHeader,
      zipPayload,
    ])

    expect(Buffer.from(stripCrxContainer(crx))).toEqual(zipPayload)
  })

  test('deriveChromeExtensionIdFromPublicKey matches official id', () => {
    const officialKey =
      'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjU1XnLPoasGVmZU42K3h6S+sQhkogfcoLPbIcrWH5Oo8QoInBIugkew/7cWaEFySyQrkaEBe1fjeS/rlAqd3r778dKcTvDZcXmj0VVX0Fi1i8tnkarurceGKGdVxfkL7e30nwfgwoPxj3H8OQbsbxFcBWGVtcFekmdpiyaxwz6o4yXIWColfAxh9K2yToOZkoAS5GvgGvTexiCh1gYy++eFdk6C61mcFsyDdoGQtduhGEaX0zZ9uAW1jX4JTPmHV3kEFrZu/WVBl7Obw+Jk/osoHMdmghVNy6SCB8/6mcgmxkP9buPrNUZgYP6n0x5dqEJ2Ecww/lb1Zd4nQf4XGOwIDAQAB'

    expect(deriveChromeExtensionIdFromPublicKey(officialKey)).toBe(
      'fcoeoabgfenejglbffodgkkbkcdhcgfn',
    )
  })
})
