import { fileNameFromUri, sanitizeFileName } from '@shared/uri'

/**
 * The name a download is filed under when the user did not type one.
 *
 * Split out of the manager so it can be unit tested: getting this wrong is not
 * cosmetic. The name decides the category (a file called `torrent` matches the
 * torrent rule by extension), so a bad name makes a video look like a torrent —
 * which is exactly the bug this helper was extracted to pin down.
 */
export function suggestedDownloadName(
  input: { out: string; torrentBase64: string | null },
  uris: string[]
): string {
  if (input.out) return sanitizeFileName(input.out)
  // `uris[0]` unless there is none, in which case a torrent body has been handed
  // to us and "torrent" is only a placeholder until aria2 reads the metadata.
  const source = uris[0] ?? (input.torrentBase64 ? 'torrent' : '')
  return fileNameFromUri(source)
}
