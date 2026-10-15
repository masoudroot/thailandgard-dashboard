export const llmState = { impl: async (..._args) => [] };
export async function callLLMJson(...args) { return llmState.impl(...args); }
export function resetLlm() { llmState.impl = async () => []; }
