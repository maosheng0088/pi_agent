import { HttpError } from './security.mjs';

/** Public IDs only: avatars are bundled assets, never arbitrary URLs or paths. */
export function validateAvatarId(value) {
  if (typeof value !== 'string' || (value !== '' && !/^portrait-(?:0[1-9]|1[0-4])$/.test(value))) {
    throw new HttpError(400, '头像须为 portrait-01 至 portrait-14，或留空恢复自动头像。');
  }
  return value;
}
