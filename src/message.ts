export const MESSAGE_CHARACTER_LIMIT = 249;

export function splitMessage(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const chunks: string[] = [];
  let rest = trimmed;

  while (rest.length > MESSAGE_CHARACTER_LIMIT) {
    const sentenceEndings = [...rest.matchAll(/[.!?]["'”’)}\]]*(?=\s|$)/g)];
    const sentenceEnd = sentenceEndings
      .map((match) => match.index! + match[0].length)
      .filter((end) => end <= MESSAGE_CHARACTER_LIMIT)
      .at(-1);
    let end = sentenceEnd ?? MESSAGE_CHARACTER_LIMIT;

    if (
      end < rest.length &&
      end > 0 &&
      rest.charCodeAt(end - 1) >= 0xd800 &&
      rest.charCodeAt(end - 1) <= 0xdbff &&
      rest.charCodeAt(end) >= 0xdc00 &&
      rest.charCodeAt(end) <= 0xdfff
    ) {
      end--;
    }

    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }

  if (rest) chunks.push(rest);
  return chunks;
}
