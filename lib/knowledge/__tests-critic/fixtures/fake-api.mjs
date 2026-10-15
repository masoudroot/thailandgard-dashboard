export const apiState = { inserts: [], nextId: 1, failInsert: false };
export function getSupabase() {
  return {
    from: (table) => ({
      insert: (row) => {
        const record = { ...row, id: `kid-test-${apiState.nextId++}` };
        apiState.inserts.push({ table, record });
        return {
          select: (_cols) => ({
            single: async () =>
              apiState.failInsert
                ? { data: null, error: { message: 'fake insert error' } }
                : { data: { id: record.id }, error: null },
          }),
        };
      },
    }),
  };
}
export function resetApi() { apiState.inserts = []; apiState.nextId = 1; apiState.failInsert = false; }
