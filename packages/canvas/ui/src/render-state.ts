import { useCallback, useLayoutEffect, useRef } from 'react'

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false
  const keys = Object.keys(a) as (keyof T)[]
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && Object.is(a[key], b[key]))
}

export function useShallowValue<T>(value: T): T {
  const previous = useRef(value)
  const stable = shallowEqual(previous.current, value) ? previous.current : value
  useLayoutEffect(() => { previous.current = stable }, [stable])
  return stable
}

export function useStableCallback<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
  const latest = useRef(callback)
  // Canvas callers run in event handlers or passive effects, after these committed bindings are installed.
  useLayoutEffect(() => { latest.current = callback }, [callback])
  return useCallback((...args: A) => latest.current(...args), [])
}
