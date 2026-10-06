import type { PaneDir, PaneTree } from '@shared/types'

export type { PaneDir, PaneTree }

export type PaneSplit<T> = Extract<PaneTree<T>, { dir: PaneDir }>
export type Direction = 'left' | 'right' | 'up' | 'down'

// fractions of the area the panes share, 0 to 1
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Divider<T> {
  node: PaneSplit<T>
  area: Rect
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }
const EPSILON = 1e-6

export function leaves<T>(node: PaneTree<T>): T[] {
  return 'tab' in node ? [node.tab] : [...leaves(node.a), ...leaves(node.b)]
}

// returning null or undefined for a leaf removes it, and its sibling takes the parent's place
export function mapPanes<A, B>(node: PaneTree<A>, f: (tab: A) => B | null | undefined): PaneTree<B> | null {
  if ('tab' in node) {
    const tab = f(node.tab)
    return tab === null || tab === undefined ? null : { tab }
  }
  const a = mapPanes(node.a, f)
  const b = mapPanes(node.b, f)
  return a && b ? { dir: node.dir, ratio: node.ratio, a, b } : (a ?? b)
}

export function insert<T>(node: PaneTree<T>, beside: T, tab: T, dir: PaneDir): PaneTree<T> {
  if ('tab' in node) return node.tab === beside ? { dir, ratio: 0.5, a: node, b: { tab } } : node
  return { dir: node.dir, ratio: node.ratio, a: insert(node.a, beside, tab, dir), b: insert(node.b, beside, tab, dir) }
}

export function sibling<T>(node: PaneTree<T>, tab: T): T | undefined {
  if ('tab' in node) return undefined
  if ('tab' in node.a && node.a.tab === tab) return leaves(node.b)[0]
  if ('tab' in node.b && node.b.tab === tab) return leaves(node.a).at(-1)
  return sibling(node.a, tab) ?? sibling(node.b, tab)
}

export function layout<T>(root: PaneTree<T>): { panes: Map<T, Rect>; dividers: Divider<T>[] } {
  const panes = new Map<T, Rect>()
  const dividers: Divider<T>[] = []
  const walk = (node: PaneTree<T>, area: Rect): void => {
    if ('tab' in node) {
      panes.set(node.tab, area)
      return
    }
    dividers.push({ node, area })
    const [a, b] = cut(area, node.dir, node.ratio)
    walk(node.a, a)
    walk(node.b, b)
  }
  walk(root, FULL)
  return { panes, dividers }
}

export function cut(area: Rect, dir: PaneDir, ratio: number): [Rect, Rect] {
  if (dir === 'row') {
    const w = area.w * ratio
    return [
      { ...area, w },
      { ...area, x: area.x + w, w: area.w - w }
    ]
  }
  const h = area.h * ratio
  return [
    { ...area, h },
    { ...area, y: area.y + h, h: area.h - h }
  ]
}

// the pane that shares the longest edge with this one on the given side
export function neighbor<T>(panes: Map<T, Rect>, from: T, toward: Direction): T | undefined {
  const r = panes.get(from)
  if (!r) return undefined
  let best: T | undefined
  let bestOverlap = EPSILON
  for (const [tab, p] of panes) {
    if (tab === from) continue
    const touches =
      toward === 'left'
        ? Math.abs(p.x + p.w - r.x) < EPSILON
        : toward === 'right'
          ? Math.abs(r.x + r.w - p.x) < EPSILON
          : toward === 'up'
            ? Math.abs(p.y + p.h - r.y) < EPSILON
            : Math.abs(r.y + r.h - p.y) < EPSILON
    if (!touches) continue
    const overlap =
      toward === 'left' || toward === 'right'
        ? Math.min(r.y + r.h, p.y + p.h) - Math.max(r.y, p.y)
        : Math.min(r.x + r.w, p.x + p.w) - Math.max(r.x, p.x)
    if (overlap > bestOverlap) {
      best = tab
      bestOverlap = overlap
    }
  }
  return best
}
