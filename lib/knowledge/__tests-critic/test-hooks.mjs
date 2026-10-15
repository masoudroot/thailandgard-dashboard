const dir = new URL('./fixtures/', import.meta.url);
export async function resolve(specifier, context, next) {
  if (specifier === '../rag' || specifier === '../api') {
    console.log('[hook] redirecting:', specifier, 'from', context.parentURL);
    return { url: new URL(specifier === '../rag' ? 'fake-rag.mjs' : 'fake-api.mjs', dir).href, shortCircuit: true };
  }
  return next(specifier, context);
}
