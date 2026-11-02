export type TableAlignment = 'left' | 'center' | 'right' | undefined
export type MessageBlock =
  | { kind: 'line'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'rule' }
  | { kind: 'code'; language: string; content: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'table'; header: string[]; alignments: TableAlignment[]; rows: string[][] }
export interface CodeSpan { start: number; end: number; content: string }
interface PipeRow { cells: string[]; delimiterCount: number }

/** Match equal-length backtick runs. Unclosed code delimiters stay ordinary
 * text, so a stray backtick cannot swallow all following table columns. */
export function inlineCodeSpans(text: string): CodeSpan[] {
  const runs: Array<{ start: number; end: number; size: number; next?: number }> = []
  const pattern = /`+/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    let slashes = 0
    for (let at = match.index - 1; at >= 0 && text[at] === '\\'; at--) slashes++
    if (slashes % 2) continue
    runs.push({ start: match.index, end: pattern.lastIndex, size: match[0].length })
  }
  const next = new Map<number, number>()
  for (let index = runs.length - 1; index >= 0; index--) { const run = runs[index]!; run.next = next.get(run.size); next.set(run.size, index) }
  const spans: CodeSpan[] = []
  for (let index = 0; index < runs.length; index++) {
    const opening = runs[index]!, closingIndex = opening.next
    if (closingIndex === undefined) continue
    const closing = runs[closingIndex]!
    spans.push({ start: opening.start, end: closing.end, content: text.slice(opening.end, closing.start) })
    index = closingIndex
  }
  return spans
}

/** Only escaped table pipes are decoded. Other Markdown escapes, entities and
 * HTML remain unchanged and are handled as text by the safe inline renderer. */
function tablePipeEscapes(value: string) { return value.replace(/(\\+)\|/g, (_match, slashes: string) => `${slashes.length % 2 ? slashes.slice(0,-1) : slashes}|`) }

export function splitPipeRow(line: string): PipeRow {
  const text = line.trim(), spans = inlineCodeSpans(text), cells: string[] = [], delimiters: number[] = []
  let cell = '', span = 0, slashes = 0
  for (let index = 0; index < text.length; index++) {
    const code = spans[span]
    if (code && code.start === index) { cell += text.slice(code.start, code.end); index = code.end - 1; span++; slashes = 0; continue }
    const character = text[index]!
    if (character === '|' && slashes % 2 === 0) { cells.push(cell); cell = ''; delimiters.push(index) } else cell += character
    slashes = character === '\\' ? slashes + 1 : 0
  }
  cells.push(cell)
  if (delimiters[0] === 0) cells.shift()
  if (delimiters.at(-1) === text.length - 1) cells.pop()
  return { cells: cells.map(value => tablePipeEscapes(value.trim())), delimiterCount: delimiters.length }
}

function tableAt(lines: string[], start: number): { block: Extract<MessageBlock, {kind: 'table'}>; end: number } | null {
  const header = splitPipeRow(lines[start]!)
  if (!header.delimiterCount || !header.cells.length) return null
  let dividerIndex = start + 1
  while (dividerIndex < lines.length && !lines[dividerIndex]!.trim()) dividerIndex++
  if (dividerIndex >= lines.length) return null
  const divider = splitPipeRow(lines[dividerIndex]!)
  if (!divider.delimiterCount || divider.cells.length !== header.cells.length || !divider.cells.every(cell => /^:?-+:?$/.test(cell))) return null
  const alignments: TableAlignment[] = divider.cells.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : undefined)
  const rows: string[][] = []
  let end = dividerIndex + 1
  while (end < lines.length) {
    let rowIndex = end
    while (rowIndex < lines.length && !lines[rowIndex]!.trim()) rowIndex++
    if (rowIndex >= lines.length) break
    if (/^(?: {4}|\t)|^ {0,3}(?:`{3,}|~{3,}|#{1,6}\s|>|(?:[-+*]|\d+[.)])\s)/.test(lines[rowIndex]!)) break
    const row = splitPipeRow(lines[rowIndex]!)
    // GFM pads short body rows. Preserve extra-cell rows as ordinary text
    // instead of silently throwing away potentially important business data.
    if (!row.delimiterCount || !row.cells.length || row.cells.length > header.cells.length) break
    rows.push([...row.cells, ...Array(header.cells.length - row.cells.length).fill('')])
    end = rowIndex + 1
  }
  return { block: { kind: 'table', header: header.cells, alignments, rows }, end }
}

/** Adapt legacy model tables to GFM without rewriting fenced/indented code.
 * Extra cells remain outside the table rather than being silently discarded. */
export function normalizeMessageTables(content: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n'), output: string[] = []
  let fence: string | undefined
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/)
    if (fence) {
      output.push(line); index++
      const trimmed = line.trim()
      if (line.length - line.trimStart().length <= 3 && trimmed.length >= fence.length && [...trimmed].every(character => character === fence![0])) fence = undefined
      continue
    }
    if (marker && !(marker[1]![0] === '`' && marker[2]!.includes('`'))) { fence = marker[1]; output.push(line); index++; continue }
    const table = /^ {0,3}\S/.test(line) ? tableAt(lines, index) : null
    if (!table) { output.push(line); index++; continue }
    const row = (cells: string[]) => `| ${cells.map(cell => cell.replace(/\|/g, '\\|')).join(' | ')} |`
    output.push('', row(table.block.header), row(table.block.alignments.map(align => align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---')))
    for (const cells of table.block.rows) output.push(row(cells))
    output.push(''); index = table.end
  }
  return output.join('\n')
}

export function messageBlocks(content: string): MessageBlock[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n'), blocks: MessageBlock[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/)
    if (fence && !(fence[1]![0] === '`' && fence[2]!.includes('`'))) {
      const marker = fence[1]!, body: string[] = []; index++
      while (index < lines.length) {
        const next = lines[index]!, closing = next.trim()
        if (next.length - next.trimStart().length <= 3 && closing.length >= marker.length && [...closing].every(character => character === marker[0])) { index++; break }
        body.push(next); index++
      }
      blocks.push({ kind: 'code', language: fence[2]!.trim(), content: body.join('\n') }); continue
    }
    const table = tableAt(lines,index)
    if (table) { blocks.push(table.block); index = table.end; continue }
    if (/^\s*---+\s*$/.test(line)) { blocks.push({ kind: 'rule' }); index++; continue }
    if (/^#{1,4}\s/.test(line)) { blocks.push({ kind: 'heading', text: line.replace(/^#{1,4}\s+/, '') }); index++; continue }
    const bullet = line.match(/^ {0,3}[-+*]\s+(.+)$/), ordered = line.match(/^ {0,3}(\d{1,9})[.)]\s+(.+)$/)
    if (bullet || ordered) {
      const items = [bullet ? bullet[1]! : ordered![2]!], start = ordered ? Number(ordered[1]) : 1; index++
      while (index < lines.length) {
        const next = ordered ? lines[index]!.match(/^ {0,3}\d{1,9}[.)]\s+(.+)$/) : lines[index]!.match(/^ {0,3}[-+*]\s+(.+)$/)
        if (!next) break
        items.push(next[1]!); index++
      }
      blocks.push({ kind: 'list', ordered: !!ordered, start, items }); continue
    }
    blocks.push({ kind: 'line', text: line }); index++
  }
  return blocks
}
