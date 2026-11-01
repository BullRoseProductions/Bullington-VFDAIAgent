export const isNative = () => false; export const apiUrl = (p) => p;
export async function authedFetch() { return new Response(JSON.stringify({ error: "sweep" }), { status: 503 }); }
