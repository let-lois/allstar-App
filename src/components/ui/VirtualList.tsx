import { useCallback, useEffect, useRef, useState } from 'react'

interface Props<T> {
  items: T[]
  /** Fixed row height in px — rows are uniform by design so this stays O(1). */
  itemHeight: number
  renderItem: (item: T, index: number) => React.ReactNode
  className?: string
  /** A `data-tour` anchor for the walkthrough, on the scroll container. */
  'data-tour'?: string
  overscan?: number
  header?: React.ReactNode
  empty?: React.ReactNode
}

/**
 * Windowed list.
 *
 * A territory is thousands of properties. Rendering them all costs a mid-range
 * Android several seconds of jank and a lot of battery, so we mount only what's
 * on screen. Kicks in above a threshold — small lists skip the machinery.
 */
export function VirtualList<T>({
  items,
  itemHeight,
  renderItem,
  className = '',
  'data-tour': tour,
  overscan = 6,
  header,
  empty,
}: Props<T>) {
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setHeight(e.contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  const total = items.length * itemHeight
  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan)
  const visibleCount = Math.ceil((height || 800) / itemHeight) + overscan * 2
  const end = Math.min(items.length, start + visibleCount)
  const slice = items.slice(start, end)

  return (
    <div ref={ref} onScroll={onScroll} data-tour={tour} className={`scroll-pane ${className}`}>
      {header}
      {items.length === 0 ? (
        empty
      ) : (
        <div style={{ height: total, position: 'relative' }}>
          <div style={{ transform: `translateY(${start * itemHeight}px)` }}>
            {slice.map((item, i) => (
              <div key={start + i} style={{ height: itemHeight }}>
                {renderItem(item, start + i)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
