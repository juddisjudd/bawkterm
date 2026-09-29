import { EditorView } from '@codemirror/view'
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'

export const editorTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text-strong)', backgroundColor: 'var(--bg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--text-strong)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text-strong)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--bg-highlight)' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-weak)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--text-weaker)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-weak)', color: 'var(--text-weak)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-weaker)', padding: '0 4px' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-weak-hover)', border: 'none', color: 'var(--text-weak)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--bg-highlight)', outline: '1px solid var(--border)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--bg-weak-hover)' },
  '.cm-searchMatch': { backgroundColor: 'var(--bg-highlight)', outline: '1px solid var(--border)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--bg-interactive)', color: 'var(--text-on-interactive)' },
  '.cm-panels': { backgroundColor: 'var(--bg-weak)', color: 'var(--text)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border-weak)' },
  '.cm-panel.cm-search': { padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: '12px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'inherit', fontSize: '12px' },
  '.cm-textfield': {
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    backgroundColor: 'var(--bg)',
    color: 'var(--text-strong)'
  },
  '.cm-button': {
    border: '1px solid var(--border-weak)',
    borderRadius: 'var(--radius)',
    backgroundImage: 'none',
    backgroundColor: 'transparent',
    color: 'var(--text-strong)'
  },
  '.cm-panel.cm-search label': { color: 'var(--text)' },
  '.cm-panel button[name=close]': { color: 'var(--text-weak)' },
  '.cm-tooltip': { border: '1px solid var(--border-weak)', backgroundColor: 'var(--bg)', color: 'var(--text)' }
})

export const editorHighlight = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier, t.self],
      color: 'var(--syntax-keyword)'
    },
    { tag: [t.string, t.special(t.string), t.regexp, t.character, t.inserted], color: 'var(--syntax-string)' },
    { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.escape, t.color], color: 'var(--syntax-number)' },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.standard(t.variableName)],
      color: 'var(--syntax-function)'
    },
    { tag: [t.typeName, t.className, t.namespace, t.labelName, t.special(t.variableName)], color: 'var(--syntax-type)' },
    { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--syntax-property)' },
    { tag: [t.tagName, t.angleBracket, t.deleted], color: 'var(--syntax-tag)' },
    { tag: [t.attributeName], color: 'var(--syntax-attribute)' },
    { tag: [t.heading], color: 'var(--text-strong)', fontWeight: '700' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.link, color: 'var(--syntax-function)', textDecoration: 'underline' },
    { tag: [t.meta, t.processingInstruction, t.documentMeta, t.punctuation], color: 'var(--text-weak)' },
    { tag: t.invalid, color: 'var(--danger)' }
  ])
)

const byName = (name: string): LanguageDescription | undefined =>
  languages.find((l) => l.name.toLowerCase() === name.toLowerCase())

const SHEBANG: [RegExp, string][] = [
  [/\b(ba|z|k|da)?sh\b/, 'Shell'],
  [/\bpython[\d.]*\b/, 'Python'],
  [/\b(node|deno|bun)\b/, 'JavaScript'],
  [/\bruby\b/, 'Ruby'],
  [/\bperl\b/, 'Perl'],
  [/\bphp\b/, 'PHP']
]

// shell dotfiles and env files have no extension language-data knows about
const FILENAMES: [RegExp, string][] = [
  [/^\.(bash|zsh|ksh)?(rc|_profile|_aliases|_logout|env)$|^\.profile$/, 'Shell'],
  [/^\.env(\..+)?$/, 'Properties files'],
  [/^(authorized_keys|known_hosts|config)$/, 'Properties files']
]

export function detectLanguage(name: string, text: string): LanguageDescription | undefined {
  const match = LanguageDescription.matchFilename(languages, name)
  if (match) return match
  for (const [pattern, lang] of FILENAMES) if (pattern.test(name)) return byName(lang)
  const first = text.slice(0, 200).split('\n', 1)[0]
  if (first.startsWith('#!')) for (const [pattern, lang] of SHEBANG) if (pattern.test(first)) return byName(lang)
  return undefined
}
