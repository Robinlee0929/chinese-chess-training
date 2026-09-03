// Deterministic, fact-free, no transport and no public fault controls.
export function fakeProvider(_input, { signal }) {
  if (signal.aborted) throw new Error('aborted');
  return { leadIn: '可以一起看看這個地方。', encouragement: '下次也可以先停一下想想。' };
}
