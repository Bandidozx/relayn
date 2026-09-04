/** Tiny class-name joiner. Keeps a dependency out of the tree for a five-line helper. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
