import { describe, expect, it } from 'vitest';
import {
  mediaTypeForMime,
  mimeTypeFromExtension,
  isAllowedUploadMimeType,
  sniffMimeType
} from '../../../packages/core/src/media/mime.js';
import { isBlockedAddress, isBlockedHostname, assertRemoteUrlSyntax } from '../../../packages/core/src/media/remote-fetch.js';
import { JPEG_BYTES, PNG_BYTES, TEXT_BYTES } from './helpers.js';

describe('sniffMimeType', () => {
  it.each([
    ['png', PNG_BYTES, 'image/png'],
    ['jpeg', JPEG_BYTES, 'image/jpeg'],
    ['gif87a', new Uint8Array([...Buffer.from('GIF87a'), 0x00]), 'image/gif'],
    ['gif89a', new Uint8Array([...Buffer.from('GIF89a'), 0x00]), 'image/gif'],
    ['webp', new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]), 'image/webp'],
    ['wav', new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE')]), 'audio/wav'],
    ['mp4', new Uint8Array([0, 0, 0, 0, ...Buffer.from('ftyp'), ...Buffer.from('isom')]), 'video/mp4'],
    ['mp3 with ID3', new Uint8Array([...Buffer.from('ID3'), 0x03]), 'audio/mpeg'],
    ['mp3 frame sync', new Uint8Array([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg']
  ])('detects %s from its magic bytes', (_label, bytes, expected) => {
    expect(sniffMimeType(bytes)).toBe(expected);
  });

  it('returns undefined for text and truncated payloads', () => {
    expect(sniffMimeType(TEXT_BYTES)).toBeUndefined();
    expect(sniffMimeType(new Uint8Array())).toBeUndefined();
    expect(sniffMimeType(PNG_BYTES.subarray(0, 3))).toBeUndefined();
    // RIFF without a WEBP/WAVE marker is not an accepted container.
    expect(sniffMimeType(new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('AVI ')]))).toBeUndefined();
  });
});

describe('media type helpers', () => {
  it('maps mime types to media types', () => {
    expect(mediaTypeForMime('image/png')).toBe('image');
    expect(mediaTypeForMime('video/mp4')).toBe('video');
    expect(mediaTypeForMime('audio/wav')).toBe('audio');
    expect(mediaTypeForMime('application/zip')).toBeUndefined();
  });

  it('accepts only the documented upload types', () => {
    expect(isAllowedUploadMimeType('image/png')).toBe(true);
    expect(isAllowedUploadMimeType('image/jpg')).toBe(true);
    expect(isAllowedUploadMimeType('audio/x-wav')).toBe(true);
    expect(isAllowedUploadMimeType('video/webm')).toBe(false);
    expect(isAllowedUploadMimeType('application/pdf')).toBe(false);
  });

  it('infers a type from an extension when the bytes cannot be read', () => {
    expect(mimeTypeFromExtension('https://cdn.example.com/a/b.PNG?token=1')).toBe('image/png');
    expect(mimeTypeFromExtension('https://cdn.example.com/a/b')).toBeUndefined();
  });
});

describe('blocked addresses', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::10.0.0.1',
    '2001:db8::1'
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:93.184.216.34'])(
    'allows %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    }
  );

  it('blocks local and internal hostnames', () => {
    for (const hostname of ['localhost', 'LOCALHOST', 'api.localhost', 'metadata.google.internal', 'printer.local', '127.0.0.1']) {
      expect(isBlockedHostname(hostname), hostname).toBe(true);
    }
    expect(isBlockedHostname('cdn.example.com')).toBe(false);
  });
});

describe('assertRemoteUrlSyntax', () => {
  it.each([
    ['http://cdn.example.com/a.png', 'https'],
    ['ftp://cdn.example.com/a.png', 'https'],
    ['file:///etc/passwd', 'https'],
    ['data:image/png;base64,AAAA', 'https'],
    ['https://user:pass@cdn.example.com/a.png', 'credentials'],
    ['https://localhost/a.png', 'local'],
    ['https://metadata.google.internal/a.png', 'local'],
    ['https://[::1]/a.png', 'local'],
    ['not a url', 'absolute']
  ])('rejects %s', (url, fragment) => {
    expect(() => assertRemoteUrlSyntax(url)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => assertRemoteUrlSyntax(url)).toThrowError(new RegExp(fragment, 'i'));
  });

  it('normalizes an allowed URL', () => {
    expect(assertRemoteUrlSyntax('https://CDN.Example.com:443/a/b.png?x=1').toString()).toBe(
      'https://cdn.example.com/a/b.png?x=1'
    );
  });
});
