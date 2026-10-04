// A stand-in for the browser's Storage (localStorage) in tests. setItem
// throws for the keys in `failing`, like a full localStorage.

export function fakeWebStorage(initial: Record<string, string> = {}, failing: string[] = []): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get length() {
      return data.size
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failing.includes(key)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      data.set(key, value)
    },
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
  }
}
