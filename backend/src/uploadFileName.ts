// ── The name of an uploaded file, as the author wrote it ──
//
// multer 1.x leaves busboy's default for multipart parameters, Latin-1, while
// browsers send the file name as raw UTF-8 bytes. Every name with a letter
// outside ASCII arrived mangled — "Havnsø" as "HavnsÃ¸" — on the upload card
// and in every export named after it. Reading the bytes back as UTF-8 undoes
// that. A name that cannot have come through that path (a character above
// U+00FF, or bytes that are not valid UTF-8) is already right and is left
// alone.

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function uploadFileName(name: string): string {
  if (!/[\x80-\xff]/.test(name) || /[^\x00-\xff]/.test(name)) return name;
  try {
    return utf8.decode(Buffer.from(name, "latin1"));
  } catch {
    return name;
  }
}
