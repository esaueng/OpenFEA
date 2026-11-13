// Worker and module-loader failures carry the URL or filesystem path of the
// module that failed (a dev server's /@fs/home/<user>/... URL, file:// URLs,
// absolute POSIX or Windows paths). Those mean nothing to a user, leak local
// directory names into the UI and into anything they screenshot or report, and
// make the message unreadable. Keep only the file name.
//
// One pattern: a URL, or an absolute path of at least two segments that starts
// a token. Unit text such as "W/m²" or "N/mm" never starts with a separator,
// and "1/2" has no leading one either.
const LOCAL_PATH_PATTERN = /\b(?:https?|file|blob):\/\/[^\s"'`<>()]+|(?<![^\s"'`(=:])(?:[a-z]:)?[\\/](?:[\w.@+~-]+[\\/])+[^\s"'`<>()\\/]+/gi;

/** Replace local file paths and module-loader URLs in an error message with bare file names. */
export function redactLocalPaths(message: string): string {
  return message.replace(LOCAL_PATH_PATTERN, (match) => {
    // Public web URLs (documentation links) are not local paths.
    // (Dev-server module URLs live under /@fs/, /@id/, /node_modules/ or /src/.)
    if (/^https?:/i.test(match) && !/\/(@|node_modules\/|src\/)/.test(match)) return match;
    return match.replace(/[?#].*$/, "").split(/[\\/]/).filter(Boolean).pop() ?? match;
  });
}
