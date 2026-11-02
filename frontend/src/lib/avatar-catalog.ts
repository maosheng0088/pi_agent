import avatar01 from '../assets/workspace/customer-avatars/avatar-01.webp'
import avatar02 from '../assets/workspace/customer-avatars/avatar-02.webp'
import avatar03 from '../assets/workspace/customer-avatars/avatar-03.webp'
import avatar04 from '../assets/workspace/customer-avatars/avatar-04.webp'
import avatar05 from '../assets/workspace/customer-avatars/avatar-05.webp'
import avatar06 from '../assets/workspace/customer-avatars/avatar-06.webp'
import avatar07 from '../assets/workspace/customer-avatars/avatar-07.webp'
import avatar08 from '../assets/workspace/customer-avatars/avatar-08.webp'
import avatar09 from '../assets/workspace/customer-avatars/avatar-09.webp'
import avatar10 from '../assets/workspace/customer-avatars/avatar-10.webp'
import avatar11 from '../assets/workspace/customer-avatars/avatar-11.webp'
import avatar12 from '../assets/workspace/customer-avatars/avatar-12.webp'
import avatar13 from '../assets/workspace/customer-avatars/avatar-13.webp'
import avatar14 from '../assets/workspace/customer-avatars/avatar-14.webp'

// IDs and order stay stable across builds and employee portrait assignment.
export const avatarOptions = Object.freeze([
  { id:'portrait-01', label:'清爽蓝', src:avatar01 },
  { id:'portrait-02', label:'星夜', src:avatar02 },
  { id:'portrait-03', label:'白狐', src:avatar03 },
  { id:'portrait-04', label:'耳麦客服', src:avatar04 },
  { id:'portrait-05', label:'墨影', src:avatar05 },
  { id:'portrait-06', label:'花语', src:avatar06 },
  { id:'portrait-07', label:'侦探', src:avatar07 },
  { id:'portrait-08', label:'樱花', src:avatar08 },
  { id:'portrait-09', label:'小恐龙', src:avatar09 },
  { id:'portrait-10', label:'雪绒', src:avatar10 },
  { id:'portrait-11', label:'小火龙', src:avatar11 },
  { id:'portrait-12', label:'魔法', src:avatar12 },
  { id:'portrait-13', label:'橘猫', src:avatar13 },
  { id:'portrait-14', label:'冰蓝', src:avatar14 },
])
export function avatarSource(id?: string): string | undefined {
  return avatarOptions.find(option => option.id === id)?.src
}
