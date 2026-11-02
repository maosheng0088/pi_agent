import assistant from '../assets/workspace/roles/bot_sparkle.svg'
import business from '../assets/workspace/roles/briefcase.svg'
import calendar from '../assets/workspace/roles/calendar_clock.svg'
import document from '../assets/workspace/roles/document.svg'
import team from '../assets/workspace/roles/people_team.svg'
import analytics from '../assets/workspace/roles/data_trending.svg'
import database from '../assets/workspace/roles/database.svg'
import conversation from '../assets/workspace/roles/chat_multiple.svg'
import customerAssistant from '../assets/workspace/customer-avatars/avatar-04.webp'
import reading from '../assets/workspace/illustrations/reading-side.svg'
import collaboration from '../assets/workspace/illustrations/sitting-reading.svg'
import weixin from '../assets/workspace/brands/wechat-appstore-512.jpg?inline'
import wecom from '../assets/workspace/brands/wecom-appstore-512.jpg?inline'
import feishu from '../assets/workspace/brands/feishu-appstore-512.jpg?inline'
import excel from '../assets/workspace/files/file_type_excel.svg'
import csv from '../assets/workspace/files/file_type_csv.svg'
import pdf from '../assets/workspace/files/file_type_pdf.svg'
import word from '../assets/workspace/files/file_type_word.svg'
import powerpoint from '../assets/workspace/files/file_type_powerpoint.svg'
import archive from '../assets/workspace/files/file_type_zip.svg'
import json from '../assets/workspace/files/file_type_json.svg'
import python from '../assets/workspace/files/file_type_python.svg'
import markdown from '../assets/workspace/files/file_type_markdown.svg'
import picture from '../assets/workspace/files/file_type_image.svg'
import sql from '../assets/workspace/files/file_type_sql.svg'
import typescript from '../assets/workspace/files/file_type_typescript.svg'
import javascript from '../assets/workspace/files/file_type_js.svg'
import html from '../assets/workspace/files/file_type_html.svg'
import { avatarSource } from './avatar-catalog'

// All artwork ships with the build; no external image requests or CDN dependency.
export const uiArtwork = { assistant, business, calendar, document, team, analytics, database, conversation, reading, collaboration, customerAssistant }

export function channelIdentity(type: string): { src?: string; label: string } {
  if (type === 'weixin') return { src: weixin, label: '个人微信' }
  if (type === 'wecom') return { src: wecom, label: '企业微信' }
  return { label: '消息渠道' }
}

export function skillArtwork(name: string, avatarId?: string): string {
  const custom = avatarSource(avatarId)
  if (custom) return custom
  if (/飞书|feishu|bitable/i.test(name)) return feishu
  if (/定时|计划|日程|schedule|cron/i.test(name)) return calendar
  if (/财务|对账|费用|成本|应收|收款|付款|报价|商务/.test(name)) return business
  if (/数据|分析|报表|chart|analytics/i.test(name)) return analytics
  if (/表格|gsheet|excel|csv/i.test(name)) return excel
  if (/提柜|码头|港口|集装箱|pierpass|terminal|同步|数据库/i.test(name)) return database
  if (/团队|人事|协作|成员/.test(name)) return team
  if (/客服|客户|消息|聊天/.test(name)) return conversation
  if (/文档|文件|单证|报关|document|pdf/i.test(name)) return document
  return assistant
}

const fileTypes: Record<string, string> = {
  xls: excel, xlsx: excel, xlsm: excel, ods: excel, csv, pdf,
  doc: word, docx: word, odt: word, ppt: powerpoint, pptx: powerpoint,
  zip: archive, rar: archive, '7z': archive, tar: archive, gz: archive,
  json, jsonl: json, py: python, md: markdown, markdown,
  png: picture, jpg: picture, jpeg: picture, gif: picture, webp: picture, svg: picture,
  sql, ts: typescript, tsx: typescript, js: javascript, jsx: javascript, html, htm: html,
}

export function fileIconSource(name: string): string {
  const path = name.split(/[?#]/, 1)[0] || ''
  const extension = path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || ''
  return fileTypes[extension] || document
}
