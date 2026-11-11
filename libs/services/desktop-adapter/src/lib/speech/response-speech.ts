/** Chunk completed prose only; never split a Unicode character or manufacture a partial word. */
export function responseSpeech(text: string, maxBytes = 4000): string[] {
  const encoder = new TextEncoder();
  const sentences = [
    ...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text),
  ].map((item) => item.segment);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const pieces =
      encoder.encode(sentence).length <= maxBytes
        ? [sentence]
        : sentence.split(/(?<=\s)/u);
    for (const piece of pieces) {
      if (encoder.encode(piece.trim()).length > maxBytes) return [];
      if (encoder.encode(current + piece).length > maxBytes) {
        if (current.trim()) chunks.push(current.trim());
        current = '';
      }
      current += piece;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
