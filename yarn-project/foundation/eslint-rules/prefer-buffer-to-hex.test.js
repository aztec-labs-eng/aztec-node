import rule from './prefer-buffer-to-hex.js';
import { typedCase, typedRuleTester } from './test-utils.js';

const buffer = "import { Buffer } from 'buffer'; const buf = Buffer.from([1, 2]); ";

typedRuleTester.run('prefer-buffer-to-hex', rule, {
  valid: [
    buffer + '`0X${buf.toString("hex")}`;',
    buffer + '`prefix:0x${buf.toString("hex")}`;',
    buffer + '`0x${buf.toString("hex")}suffix`;',
    buffer + '`0x${buf.toString("base64")}`;',
    'const buf = { toString: (encoding: string) => encoding }; `0x${buf.toString("hex")}`;',
    'class Buffer { toString(encoding: string) { return encoding; } } const buf = new Buffer(); `0x${buf.toString("hex")}`;',
    'declare const buf: any; `0x${buf.toString("hex")}`;',
  ].map(typedCase),
  invalid: [
    buffer + '`0x${buf.toString("hex")}`;',
    "import { Buffer } from 'buffer'; `0x${Buffer.alloc(0).toString('hex')}`;",
    "import { Buffer as Bytes } from 'buffer'; const buf = Bytes.from([1]); `0x${buf.toString('hex')}`;",
    "import type { Buffer } from 'buffer'; declare const buf: Buffer; `0x${buf.toString('hex')}`;",
  ].map(code => ({ ...typedCase(code), errors: [{ messageId: 'preferBufferToHex' }] })),
});
