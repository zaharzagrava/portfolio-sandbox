export interface ConflictNameInput {
  path: string;
  deviceId: string;
  /** The instant of the conflict, from the platform clock; only its UTC date is used. */
  at: Date;
  /** True when a live asset already holds the candidate path. */
  isTaken: (candidate: string) => boolean;
}

/** The file name extension (with its dot) of a path: from the last dot of the last segment; a leading dot is no extension. */
function split(path: string): { stem: string; extension: string } {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const hasExtension = dot > slash + 1;
  return hasExtension
    ? { stem: path.slice(0, dot), extension: path.slice(dot) }
    : { stem: path, extension: '' };
}

/** `<name> (conflicted copy <deviceId> <UTC date>)`, the part of a copy's path before any ` (n)` and the extension. */
export function conflictedCopyBase(
  path: string,
  deviceId: string,
  at: Date,
): string {
  const date = at.toISOString().slice(0, 10);
  return `${split(path).stem} (conflicted copy ${deviceId} ${date})`;
}

/**
 * `<name> (conflicted copy <deviceId> <UTC date>)<extension>`, with ` (2)`, ` (3)` appended before the extension while
 * the name is taken (S31 FR-018, AS-23). The extension is the part from the last dot of the file name; a leading dot
 * (`.env`) or a dot in a directory name is not an extension. Pure: the clock value and the taken check are passed in.
 */
export function conflictedCopyPath(input: ConflictNameInput): string {
  const { path, deviceId, at, isTaken } = input;
  const base = conflictedCopyBase(path, deviceId, at);
  const { extension } = split(path);
  let candidate = `${base}${extension}`;
  for (let n = 2; isTaken(candidate); n++)
    candidate = `${base} (${n})${extension}`;
  return candidate;
}
