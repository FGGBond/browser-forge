export function createMediaRange(header, size) {
  if (!Number.isSafeInteger(size) || size <= 0) throw mediaError(416, 'INVALID_RANGE', 'Media is empty')
  if (!header) return { status: 200, start: 0, end: size - 1, length: size }
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match || (!match[1] && !match[2])) throw mediaError(416, 'INVALID_RANGE', 'Invalid byte range')

  let start
  let end
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw mediaError(416, 'INVALID_RANGE', 'Invalid byte range')
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    throw mediaError(416, 'INVALID_RANGE', 'Requested byte range is not satisfiable')
  }
  return { status: 206, start, end, length: end - start + 1 }
}

function mediaError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}
