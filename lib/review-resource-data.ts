// Data-only projection at the trusted review-input boundary. No filesystem,
// network, subprocess, template evaluation, decompression or recursive decoding.
export const RESOURCE_BYTE_LIMIT = 256 * 1024;
export const RESOURCE_TOTAL_BYTE_LIMIT = 2 * 1024 * 1024;
export const RESOURCE_COUNT_LIMIT = 256;
export interface ReviewResourceData { path: string; uri: string; side: string; text: string; }

export function decodeReviewResourceData(diff: string): ReviewResourceData[] {
  const resources: ReviewResourceData[] = [];
  let path = '';
  let total = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)?.[2] || '';
      continue;
    }
    // Only the portable catalog's documented URI-keyed base64 resource map.
    // Metadata descriptors (uri/digest/size) are not encoded resource values.
    if (!path.endsWith('/mcp-portable-skills-catalog.json') && path !== 'mcp-portable-skills-catalog.json') continue;
    if (!/^[+ -]\s*"skill:\/\//.test(line)) continue;
    const fail = () => new Error('Review resource data is malformed, unsupported or exceeds safe decoding limits; review input was not sent.');
    if (resources.length >= RESOURCE_COUNT_LIMIT || line.length > Math.ceil(RESOURCE_BYTE_LIMIT / 3) * 4 + 4096) throw fail();
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(`{${line.slice(1).trim().replace(/,$/, '')}}`); } catch { throw fail(); }
    const pairs = Object.entries(entry);
    if (pairs.length !== 1) throw fail();
    const [uri, encoded] = pairs[0];
    if (uri.length > 2048 || !/^skill:\/\/portable\/[^\s\x00-\x1f]+$/.test(uri) || typeof encoded !== 'string') throw fail();
    if (encoded.length > Math.ceil(RESOURCE_BYTE_LIMIT / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw fail();
    const bytes = Buffer.from(encoded, 'base64');
    total += bytes.length;
    if (bytes.length > RESOURCE_BYTE_LIMIT || total > RESOURCE_TOTAL_BYTE_LIMIT || bytes.toString('base64') !== encoded) throw fail();
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail(); }
    // Binary/control payloads are not supported text, even if valid UTF-8.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw fail();
    resources.push({ path, uri, side: line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : 'context', text });
  }
  return resources;
}
