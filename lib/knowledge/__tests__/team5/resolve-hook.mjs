import { pathToFileURL } from 'node:url';
const dir = new URL('./', import.meta.url);
export async function resolve(specifier, context, next) {
  if (specifier === './api' || specifier === '../api') {
    return { url: new URL('fake-api.mjs', dir).href, shortCircuit: true };
  }
  if (specifier === './llm' || specifier === '../llm') {
    return { url: new URL('fake-llm.mjs', dir).href, shortCircuit: true };
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    try {
      return await next(specifier, context);
    } catch (err) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.[A-Za-z0-9]+$/.test(url.pathname)) {
        for (const suffix of ['.ts', '/index.ts']) {
          try { return await next(url.href + suffix, context); } catch {}
        }
      }
      throw err;
    }
  }
  return next(specifier, context);
}
export { pathToFileURL };
