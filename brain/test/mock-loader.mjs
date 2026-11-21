// 把 @snowluma/sdk 解析到 mock 实现。
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@snowluma/sdk') {
    return {
      url: new URL('./mock-snowluma.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
