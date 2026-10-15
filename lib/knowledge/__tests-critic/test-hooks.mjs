const dir = new URL('./fixtures/', import.meta.url);
export async function resolve(specifier, context, next) {
  if (specifier === '../rag') {
    return { url: new URL('fake-rag.mjs', dir).href, shortCircuit: true };
  }
  if (specifier === '../api') {
    return { url: new URL('fake-api.mjs', dir).href, shortCircuit: true };
  }
  return next(specifier, context);
}
