import { avatarOptions } from './avatar-catalog'

const portraits = avatarOptions.map(option => option.src)
export function userAvatarSource(identity?: string, external = false): string | undefined {
  if (!identity || external || /^(?:weixin|wecom):/.test(identity)) return
  let hash = 2166136261
  for (const character of identity) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619)
  return portraits[(hash >>> 0) % portraits.length]
}
