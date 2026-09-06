export const CAPTURE_TIMEOUT_MS = 8000
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024
export async function boundedCapture<T>(operation: () => Promise<T>, signal: AbortSignal, milliseconds = CAPTURE_TIMEOUT_MS): Promise<T> {
  if (signal.aborted) throw new Error('Browser screenshot cancelled.')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  const cancellation = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Browser screenshot cancelled.'))
    signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => reject(new Error('Browser screenshot timed out. The page did not produce a capture.')), milliseconds)
  })
  try {
    const result = await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw new Error('Browser screenshot cancelled.'); return operation() }), cancellation])
    if (signal.aborted) throw new Error('Browser screenshot cancelled.')
    return result
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}
export function capturePng(data: unknown): Buffer {
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(MAX_CAPTURE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new Error('Browser screenshot returned invalid or oversized image data.')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length < 24 || bytes.length > MAX_CAPTURE_BYTES || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    throw new Error('Browser screenshot returned an empty or invalid PNG.')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height || width * height > 12_000_000) throw new Error('Browser screenshot dimensions are empty or exceed the capture limit.')
  return bytes
}
