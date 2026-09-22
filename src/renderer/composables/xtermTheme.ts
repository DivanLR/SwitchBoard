import type { ITheme } from '@xterm/xterm'
import type { Settings } from '@shared/domain'

export function xtermTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string): string => style.getPropertyValue(name).trim()
  return {
    background: token('--bg-code'),
    foreground: token('--text-body'),
    cursor: token('--green'),
    cursorAccent: token('--bg-code'),
    selectionBackground: token('--bg-hover'),
    black: token('--term-black'),
    red: token('--term-red'),
    green: token('--term-green'),
    yellow: token('--term-yellow'),
    blue: token('--term-blue'),
    magenta: token('--term-magenta'),
    cyan: token('--term-cyan'),
    white: token('--term-white'),
    brightBlack: token('--term-bright-black'),
    brightRed: token('--term-bright-red'),
    brightGreen: token('--term-bright-green'),
    brightYellow: token('--term-bright-yellow'),
    brightBlue: token('--term-bright-blue'),
    brightMagenta: token('--term-bright-magenta'),
    brightCyan: token('--term-bright-cyan'),
    brightWhite: token('--term-bright-white'),
  }
}

const FONT_SCALE: Record<Settings['fontSize'], number> = { sm: 11, md: 12, lg: 13.5 }

export function xtermFontSize(size: Settings['fontSize'] | undefined): number {
  return FONT_SCALE[size ?? 'md']
}

export function xtermFontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()
}
