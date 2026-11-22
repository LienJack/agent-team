/** Resolves with `promise`, or undefined once `ms` passed (the promise keeps running). */
export function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}
