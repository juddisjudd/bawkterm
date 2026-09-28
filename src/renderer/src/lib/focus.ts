import type { Attachment } from 'svelte/attachments'

export function focusOnMount(enabled = true): Attachment<HTMLElement> {
  return (el) => {
    if (enabled) queueMicrotask(() => el.focus())
  }
}
