export interface ByteRange {
  end: number;
  start: number;
}

export function parseSingleByteRange(value: string, size: number): ByteRange | null {
  if (!value.startsWith('bytes=') || value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return null;

  const [, startText, endText] = match;
  if (!startText && !endText) return null;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd)) return null;
  if (start < 0 || start >= size || requestedEnd < start) return null;

  return { start, end: Math.min(requestedEnd, size - 1) };
}
