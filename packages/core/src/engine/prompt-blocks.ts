// Building blocks of every dispatch prompt (spec §7, M8): delimited data blocks and one-line
// inline text. Shared by the impl/fix/review prompt (prompt.ts), the research prompt and the
// research reference block (prompt-research.ts).

/** Block markers in a payload become look-alikes that open or close nothing. */
export const defuse = (text: string) => text.replace(/<<</g, '‹‹‹').replace(/>>>/g, '›››');

/**
 * A delimited data block (M8): `<<<DATA name#dispatch>>>` … `<<<END name#dispatch>>>`. The tag
 * carries this run's dispatch id, which did not exist when the text was written (tickets,
 * receipts and diffs come from earlier steps), and any `<<<`/`>>>` inside the text is replaced,
 * so the payload can neither close its block early nor open a new one.
 */
export function dataBlock(name: string, dispatchId: string, text: string): string {
  const tag = `${name}#${dispatchId}`;
  return `<<<DATA ${tag}>>>\n${defuse(text).replace(/\n+$/, '')}\n<<<END ${tag}>>>`;
}

/**
 * Text that has to sit outside a data block (the task title on the header line): one line,
 * markers defused, so it can neither start a section of its own nor open or close a block.
 */
export function inlineText(text: string): string {
  return defuse(text.replace(/\s+/g, ' ').trim());
}

export function bullet(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join('\n');
}
